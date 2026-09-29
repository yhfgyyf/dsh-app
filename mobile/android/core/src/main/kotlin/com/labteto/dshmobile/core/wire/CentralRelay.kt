package com.labteto.dshmobile.core.wire

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content
internal fun remoteObject(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    for ((key, value) in pairs) when(value) {
        is String -> put(key, value); is Number -> put(key, JsonPrimitive(value)); is Boolean -> put(key, value)
        is JsonElement -> put(key, value); null -> {}; else -> error("Unsupported value")
    }
}

/** Credentials are serialized only inside the Android Keystore-backed credential store. */
data class CentralCredential(val bindingId: String, val bindingToken: String, val key: String) {
    fun encode(): String = remoteObject("bindingId" to bindingId, "bindingToken" to bindingToken, "key" to key).toString()
    companion object { fun decode(value: String): CentralCredential {
        val o = Json.parseToJsonElement(value).jsonObject
        CentralCrypto.decode(o.text("key"), 32)
        return CentralCredential(o.text("bindingId"), o.text("bindingToken"), o.text("key"))
    } }
}

data class CentralPairCode(val relay: String, val deviceId: String, val name: String, val inviteId: String, val claimSecret: String, val key: String, val expiresAt: Long) {
    companion object {
        fun parse(value: String): CentralPairCode? = runCatching {
            require(value.length <= 4096)
            val o = Json.parseToJsonElement(value).jsonObject
            require(o.text("kind") == "dsh-desktop-pair" && o.getValue("version").jsonPrimitive.int == 1)
            val relay = centralOrigin(o.text("relay"))
            CentralCrypto.decode(o.text("key"), 32)
            CentralPairCode(relay, o.text("deviceId"), o.text("name"), o.text("inviteId"), o.text("claimSecret"), o.text("key"), o.getValue("expiresAt").jsonPrimitive.long)
        }.getOrNull()
    }
}
fun centralOrigin(value: String): String {
    val u = value.toHttpUrl()
    require(u.username.isEmpty() && u.password.isEmpty() && u.encodedPath == "/" && u.query == null && u.fragment == null)
    require(u.isHttps || u.host in setOf("localhost", "127.0.0.1", "::1")) { "HTTPS required" }
    return u.toString().removeSuffix("/")
}
fun centralPost(http: OkHttpClient, origin: String, path: String, body: JsonObject, token: String? = null): JsonObject {
    val request = Request.Builder().url(centralOrigin(origin) + "/v1/" + path)
        .post(body.toString().toRequestBody("application/json".toMediaType()))
    if (token != null) request.header("Authorization", "Bearer $token")
    http.newBuilder().followRedirects(false).followSslRedirects(false).callTimeout(15, TimeUnit.SECONDS).build().newCall(request.build()).execute().use {
        if (!it.isSuccessful) throw RpcTransportException(it.code, "Relay request failed (${it.code})")
        val bytes = it.body?.byteStream()?.remoteReadLimited(65537) ?: throw IOException("Empty relay response")
        require(bytes.size <= 65536)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
    }
}

/** One authenticated session. Reconnects are owned by ConnectionLoop, never by this transport. */
internal class CentralTunnel(private val http: OkHttpClient, private val origin: String, private val credential: CentralCredential, private val onFrame: ((JsonObject) -> Unit)? = null, private val onClosed: ((Throwable?) -> Unit)? = null) : AutoCloseable {
    private val ready = CountDownLatch(1)
    private val queue = ArrayBlockingQueue<JsonObject>(128)
    @Volatile private var failure: Throwable? = null
    @Volatile private var closed = false
    @Volatile private var socket: WebSocket? = null
    @Volatile private var cipher: CentralCipher? = null
    private var session = ""
    private var random = ""
    fun connect() {
        val ticket = centralPost(http, origin, "ticket", remoteObject("bindingId" to credential.bindingId), credential.bindingToken)
        check(!closed) { "Remote closed" }
        session = ticket.text("accessSessionId"); random = CentralCrypto.random()
        // Ignore server-supplied redirect URLs: the configured, trusted origin owns this socket.
        val request = Request.Builder().url(centralOrigin(origin).replaceFirst("http", "ws") + "/v1/tunnel").build()
        socket = http.newBuilder().pingInterval(25, TimeUnit.SECONDS).build().newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) { if (closed) { ws.cancel(); return }; ws.send(remoteObject("type" to "auth", "ticket" to ticket.text("ticket")).toString()) }
            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    require(text.length <= 256 * 1024)
                    val m = Json.parseToJsonElement(text).jsonObject
                    when (m.text("type")) {
                        "auth_ok" -> ws.send(remoteObject("type" to "client_hello", "accessSessionId" to session, "clientRandomB64" to random, "clientProofB64" to CentralCrypto.proof(credential.key, session, random)).toString())
                        "server_hello" -> { check(cipher == null); cipher = CentralCrypto.client(credential.key, session, random, m); ready.countDown() }
                        "sealed" -> {
                            require(m.text("accessSessionId") == session)
                            val inner = checkNotNull(cipher).open(m)
                            if (onFrame != null) onFrame.invoke(inner) else check(queue.offer(inner)) { "Receive buffer full" }
                        }
                        else -> throw IOException("Desktop closed access")
                    }
                } catch (e: Throwable) { fail(e); ws.cancel() }
            }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = fail(t)
            override fun onClosed(ws: WebSocket, code: Int, reason: String) = fail(IOException("Remote disconnected"))
        })
        if (!ready.await(15, TimeUnit.SECONDS)) { close(); throw IOException("Remote handshake timeout") }
        failure?.let { throw IOException("Remote handshake failed", it) }
        check(cipher != null)
    }
    private fun fail(e: Throwable) { if (failure == null) { failure = e; ready.countDown(); onClosed?.invoke(e) } }
    @Synchronized fun send(value: JsonObject) {
        failure?.let { throw IOException("Remote closed", it) }
        val ws = checkNotNull(socket)
        if (ws.queueSize() > 4 * 1024 * 1024) { close(); throw IOException("Remote send buffer full") }
        val sealed = checkNotNull(cipher).seal(value)
        check(ws.send(JsonObject(sealed + mapOf("type" to JsonPrimitive("sealed"), "accessSessionId" to JsonPrimitive(session))).toString()))
    }
    fun receive(): JsonObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        while (System.nanoTime() < deadline) {
            failure?.let { throw IOException("Remote disconnected", it) }
            val m = queue.poll(250, TimeUnit.MILLISECONDS) ?: continue
            if (m.text("type") == "http_error") throw IOException("Desktop request failed")
            return m
        }
        throw IOException("Remote response timeout")
    }
    override fun close() { closed = true; socket?.cancel(); socket = null; failure = IOException("Remote closed"); ready.countDown() }
}

class CentralRpcTransport(private val origin: String, private val http: OkHttpClient, private val credential: CentralCredential) : RpcTransport {
    private fun start(t: CentralTunnel, path: String, method: String, contentType: String, length: Long, body: InputStream?, onProgress: ((Long) -> Unit)?): JsonObject {
        require(length in 0..256L * 1024 * 1024)
        t.connect(); t.send(remoteObject("type" to "http_open", "channel" to "rpc", "method" to method, "path" to path, "contentType" to contentType, "length" to length))
        fun ack(seq: Int) { val m = t.receive(); check(m.text("type") == "http_ack" && m.getValue("seq").jsonPrimitive.int == seq) { "Upload acknowledgement failed" } }
        ack(-1)
        val chunk = ByteArray(48 * 1024); var sent = 0L; var seq = 0
        if (body != null) while (true) {
            val count = body.read(chunk); if (count < 0) break; if (count == 0) continue
            sent += count; require(sent <= length)
            t.send(remoteObject("type" to "http_data", "channel" to "rpc", "seq" to seq, "data" to Base64.getEncoder().encodeToString(chunk.copyOf(count)))); ack(seq++)
            onProgress?.invoke(sent)
        }
        require(sent == length)
        t.send(remoteObject("type" to "http_end", "channel" to "rpc"))
        val head = t.receive(); check(head.text("type") == "http_head")
        val status = head.getValue("status").jsonPrimitive.int
        if (status !in 200..299) throw RpcTransportException(status, "Desktop refused operation ($status)")
        return head
    }
    private fun stream(t: CentralTunnel): InputStream = object : InputStream() {
        var chunk = ByteArray(0); var offset = 0; var seq = 0; var total = 0L; var done = false
        override fun read(): Int { val one = ByteArray(1); return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 255 }
        override fun read(out: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            while (offset >= chunk.size && !done) {
                val m = t.receive()
                if (m.text("type") == "http_end") { done = true; break }
                check(m.text("type") == "http_data" && m.getValue("seq").jsonPrimitive.int == seq++)
                chunk = Base64.getDecoder().decode(m.text("data")); offset = 0; total += chunk.size
                t.send(remoteObject("type" to "http_response_ack", "channel" to "rpc", "seq" to (seq - 1)))
                require(total <= 256L * 1024 * 1024)
            }
            if (done) return -1
            val count = minOf(len, chunk.size - offset); chunk.copyInto(out, off, offset, offset + count); offset += count; return count
        }
    }
    private fun response(t: CentralTunnel, head: JsonObject): RpcHttpResponse {
        val data = stream(t).remoteReadLimited(16 * 1024 * 1024 + 1); require(data.size <= 16 * 1024 * 1024)
        val type = head["contentType"]?.jsonPrimitive?.contentOrNull
        return if (type?.startsWith("multipart/") == true) RpcHttpResponse(200, "", type, data) else RpcHttpResponse(200, data.toString(Charsets.UTF_8), type)
    }
    override suspend fun post(path: String, body: String): RpcHttpResponse = withContext(Dispatchers.IO) {
        CentralTunnel(http, origin, credential).use { t -> val bytes = body.toByteArray(); response(t, start(t, path, "POST", "application/json", bytes.size.toLong(), bytes.inputStream(), null)) }
    }
    override suspend fun <T> download(path: String, consume: (String?, String?, InputStream) -> T): T = withContext(Dispatchers.IO) {
        CentralTunnel(http, origin, credential).use { t -> val h = start(t, path, "GET", "application/octet-stream", 0, null, null); consume(h["contentType"]?.jsonPrimitive?.contentOrNull, h["contentDisposition"]?.jsonPrimitive?.contentOrNull, stream(t)) }
    }
    override suspend fun upload(path: String, contentType: String, contentLength: Long, body: InputStream, onProgress: ((Long) -> Unit)?): RpcHttpResponse = withContext(Dispatchers.IO) {
        CentralTunnel(http, origin, credential).use { t -> response(t, start(t, path, "POST", contentType, contentLength, body, onProgress)) }
    }
}

class CentralWsChannel(origin: String, http: OkHttpClient, credential: CentralCredential, private val sink: WsChannelSink) : WsChannel("", http, sink) {
    private val buffer = ByteArrayOutputStream()
    @Volatile private var stopped = false
    private val started = java.util.concurrent.atomic.AtomicBoolean(false)
    private val tunnel = CentralTunnel(http, origin, credential, { m ->
        when (m.text("type")) {
            "ws_open" -> sink.onOpen()
            "ws_data" -> {
                val bytes = Base64.getDecoder().decode(m.text("data")); require(buffer.size() + bytes.size <= 4 * 1024 * 1024); buffer.write(bytes)
                if (m.getValue("final").jsonPrimitive.boolean) { sink.onMessage(buffer.toString("UTF-8")); buffer.reset() }
            }
            "ws_close" -> sink.onClosed(null)
        }
    }, { e -> if (!stopped) sink.onClosed(e) })
    override fun start() {
        if (stopped || !started.compareAndSet(false, true)) return
        Thread({ try { tunnel.connect(); if (!stopped) tunnel.send(remoteObject("type" to "ws_open", "channel" to "mux")) } catch(e: Throwable) { if (!stopped) sink.onClosed(e) } }, "dsh-remote-connect").apply { isDaemon = true; start() }
    }
    override fun send(text: String): Boolean = runCatching { tunnel.send(remoteObject("type" to "ws_data", "channel" to "mux", "text" to text)); true }.getOrDefault(false)
    override fun close() { stopped = true; tunnel.close() }
}

private fun InputStream.remoteReadLimited(limit: Int): ByteArray {
    val out = ByteArrayOutputStream(); val chunk = ByteArray(8192)
    while (out.size() < limit) { val count = read(chunk, 0, minOf(chunk.size, limit - out.size())); if (count < 0) break; if (count > 0) out.write(chunk, 0, count) }
    return out.toByteArray()
}
