package com.labteto.dshmobile.core.wire

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.net.NetworkInterface
import java.util.Base64
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay
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
data class CentralCredential(
    val bindingId: String, val bindingToken: String, val key: String,
    val computerId: String? = null, val lanOrigins: List<String> = emptyList(), val relay: String? = null,
) {
    fun encode(): String = remoteObject("bindingId" to bindingId, "bindingToken" to bindingToken, "key" to key,
        "computerId" to computerId, "lanOrigins" to JsonArray(lanOrigins.map(::JsonPrimitive)), "relay" to relay).toString()
    companion object { fun decode(value: String): CentralCredential {
        val o = Json.parseToJsonElement(value).jsonObject
        CentralCrypto.decode(o.text("key"), 32)
        require(remoteId(o.text("bindingId")))
        val computerId = o["computerId"]?.jsonPrimitive?.contentOrNull
        require(computerId == null || remoteId(computerId))
        val origins = o["lanOrigins"]?.jsonArray?.map { lanOrigin(it.jsonPrimitive.content) } ?: emptyList()
        require(origins.size <= 16)
        val relay = o["relay"]?.jsonPrimitive?.contentOrNull?.let(::centralOrigin)
        val token = o.text("bindingToken")
        require(token.isEmpty() || remoteId(token))
        return CentralCredential(o.text("bindingId"), token, o.text("key"), computerId, origins, relay)
    } }
}

private fun remoteId(value: String): Boolean = value.matches(Regex("[A-Za-z0-9_-]{8,128}"))

data class CentralPairCode(
    val relay: String, val deviceId: String, val name: String, val inviteId: String,
    val claimSecret: String, val key: String, val expiresAt: Long,
    val computerId: String = deviceId, val lanOrigins: List<String> = emptyList(),
    val localInviteId: String? = null, val version: Int = 1,
) {
    companion object {
        fun parse(value: String): CentralPairCode? = runCatching {
            require(value.length <= 8192)
            val o = Json.parseToJsonElement(value).jsonObject
            require(o.text("kind") == "dsh-desktop-pair")
            val version = o.getValue("version").jsonPrimitive.int
            require(version in 1..2)
            CentralCrypto.decode(o.text("key"), 32)
            val name = o.text("name"); require(name.isNotBlank() && name.length <= 80)
            val expires = o.getValue("expiresAt").jsonPrimitive.long
            if (version == 1) return@runCatching CentralPairCode(centralOrigin(o.text("relay")), o.text("deviceId"), name,
                o.text("inviteId"), o.text("claimSecret"), o.text("key"), expires)
            val relay = o["relay"]?.jsonObject
            val lan = o["lan"]?.jsonObject
            val origins = lan?.get("origins")?.jsonArray?.map { lanOrigin(it.jsonPrimitive.content) } ?: emptyList()
            require(origins.size <= 16 && (origins.isNotEmpty() || relay != null))
            val computer = o.text("computerId"); require(remoteId(computer))
            val localInvite = lan?.get("inviteId")?.jsonPrimitive?.content
            require(localInvite == null || remoteId(localInvite))
            require(origins.isEmpty() || localInvite != null)
            if (relay != null) require(listOf("deviceId", "inviteId", "claimSecret").all { remoteId(relay.text(it)) })
            CentralPairCode(relay?.let { centralOrigin(it.text("origin")) } ?: "", relay?.text("deviceId") ?: "", name,
                relay?.text("inviteId") ?: "", relay?.text("claimSecret") ?: "", o.text("key"), expires,
                computer, origins, localInvite, version)
        }.getOrNull()
    }
}

private fun ipv4(value: String): Long? {
    val parts = value.split('.')
    if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.any { c -> c !in '0'..'9' } || it.toInt() !in 0..255 }) return null
    return parts.fold(0L) { n, p -> (n shl 8) or p.toLong() }
}
internal fun lanOrigin(value: String): String {
    val u = value.toHttpUrl()
    require(u.scheme == "http" && u.username.isEmpty() && u.password.isEmpty() && u.encodedPath == "/" && u.query == null && u.fragment == null)
    val ip = requireNotNull(ipv4(u.host))
    require(ip ushr 24 == 10L || ip ushr 16 == 0xc0a8L || ip ushr 20 == 0xac1L)
    require(u.port >= 1024)
    return u.toString().removeSuffix("/")
}
internal fun onLocalNetwork(origin: String): Boolean = runCatching {
    val peer = requireNotNull(ipv4(origin.toHttpUrl().host))
    NetworkInterface.getNetworkInterfaces().toList().any { network ->
        network.isUp && !network.isLoopback && network.interfaceAddresses.any { local ->
            val ip = ipv4(local.address.hostAddress ?: "")
            val prefix = local.networkPrefixLength.toInt()
            ip != null && prefix in 1..32 && (peer ushr (32 - prefix)) == (ip ushr (32 - prefix))
        }
    }
}.getOrDefault(false)

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

/** One attempt owns its own handshake and cipher, so failed LAN callbacks cannot poison fallback. */
private class RemoteSocket(
    private val http: OkHttpClient, private val url: String, private val auth: JsonObject,
    private val key: String, private var session: String = "",
    private val onFrame: ((JsonObject) -> Unit)? = null, private val onClosed: ((Throwable?) -> Unit)? = null,
) : AutoCloseable {
    private val ready = CountDownLatch(1)
    private val queue = ArrayBlockingQueue<JsonObject>(128)
    @Volatile private var failure: Throwable? = null
    @Volatile private var closed = false
    @Volatile private var connected = false
    @Volatile private var socket: WebSocket? = null
    @Volatile private var cipher: CentralCipher? = null
    private val random = CentralCrypto.random()
    fun connect(timeoutMs: Long) {
        check(!closed)
        val request = Request.Builder().url(url).build()
        socket = http.newBuilder().followRedirects(false).followSslRedirects(false).pingInterval(25, TimeUnit.SECONDS).build().newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) { if (closed) { ws.cancel(); return }; ws.send(auth.toString()) }
            override fun onMessage(ws: WebSocket, text: String) {
                if (closed) return
                try {
                    require(text.length <= 256 * 1024)
                    val m = Json.parseToJsonElement(text).jsonObject
                    when (m.text("type")) {
                        "auth_ok" -> {
                            if (session.isEmpty()) session = m.text("accessSessionId")
                            require(remoteId(session))
                            ws.send(remoteObject("type" to "client_hello", "accessSessionId" to session, "clientRandomB64" to random, "clientProofB64" to CentralCrypto.proof(key, session, random)).toString())
                        }
                        "server_hello" -> { check(cipher == null); cipher = CentralCrypto.client(key, session, random, m); ready.countDown() }
                        "sealed" -> {
                            require(m.text("accessSessionId") == session)
                            val inner = checkNotNull(cipher).open(m)
                            if (onFrame != null) onFrame.invoke(inner) else check(queue.offer(inner)) { "Receive buffer full" }
                        }
                        else -> throw IOException("Desktop closed access")
                    }
                } catch (e: Exception) { fail(e); ws.cancel() }
            }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) = fail(t)
            override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null) }
            override fun onClosed(ws: WebSocket, code: Int, reason: String) = fail(IOException("Remote disconnected"))
        })
        if (closed) socket?.cancel()
        if (!ready.await(timeoutMs, TimeUnit.MILLISECONDS)) throw IOException("Remote handshake timeout")
        failure?.let { throw IOException("Remote handshake failed", it) }
        check(cipher != null && !closed)
        connected = true
    }
    @Synchronized private fun fail(e: Throwable) {
        if (failure == null && !closed) { failure = e; ready.countDown(); if (connected) onClosed?.invoke(e) }
    }
    @Synchronized fun send(value: JsonObject) {
        failure?.let { throw IOException("Remote closed", it) }
        check(!closed)
        val ws = checkNotNull(socket)
        if (ws.queueSize() > 4 * 1024 * 1024) { close(); throw IOException("Remote send buffer full") }
        val sealed = checkNotNull(cipher).seal(value)
        check(ws.send(JsonObject(sealed + mapOf("type" to JsonPrimitive("sealed"), "accessSessionId" to JsonPrimitive(session))).toString()))
    }
    fun receive(timeoutSeconds: Long = 120): JsonObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        while (System.nanoTime() < deadline) {
            // A paired/unbound receipt may arrive immediately before a normal server close.
            val m = queue.poll() ?: run {
                failure?.let { throw IOException("Remote disconnected", it) }
                queue.poll(250, TimeUnit.MILLISECONDS)
            } ?: continue
            if (m.text("type") == "http_error") {
                val status = m["status"]?.jsonPrimitive?.intOrNull?.takeIf { it in 400..599 } ?: 502
                throw RpcTransportException(status, if (status == 403) "This operation is not available through remote access." else "Desktop request failed")
            }
            return m
        }
        throw IOException("Remote response timeout")
    }
    override fun close() { closed = true; socket?.cancel(); socket = null; failure = IOException("Remote closed"); ready.countDown() }
}

/** Automatically chooses a reachable local address before the registered relay. */
internal class CentralTunnel(
    private val http: OkHttpClient, private val origin: String, private val credential: CentralCredential,
    private val onFrame: ((JsonObject) -> Unit)? = null, private val onClosed: ((Throwable?) -> Unit)? = null,
) : AutoCloseable {
    @Volatile private var active: RemoteSocket? = null
    @Volatile private var closed = false
    fun connect() {
        var failure: Exception = IOException("Computer is not on this network")
        for (lan in credential.lanOrigins.filter(::onLocalNetwork)) {
            if (credential.computerId == null) break
            val attempt = RemoteSocket(http, lan.replaceFirst("http", "ws") + "/v1/lan",
                remoteObject("type" to "auth", "computerId" to credential.computerId, "bindingId" to credential.bindingId), credential.key,
                onFrame = onFrame, onClosed = onClosed)
            active = attempt
            try { check(!closed); attempt.connect(1800); return }
            catch (e: Exception) { failure = e; attempt.close(); if (closed) throw e }
        }
        val relay = credential.relay ?: origin.takeIf { credential.computerId == null }
        if (relay == null || credential.bindingToken.isEmpty()) throw failure
        val ticket = centralPost(http, relay, "ticket", remoteObject("bindingId" to credential.bindingId), credential.bindingToken)
        val attempt = RemoteSocket(http, centralOrigin(relay).replaceFirst("http", "ws") + "/v1/tunnel",
            remoteObject("type" to "auth", "ticket" to ticket.text("ticket")), credential.key, ticket.text("accessSessionId"), onFrame, onClosed)
        active = attempt
        try { check(!closed); attempt.connect(15000) } catch (e: Exception) { attempt.close(); throw e }
    }
    fun send(value: JsonObject) = checkNotNull(active).send(value)
    fun receive(timeoutSeconds: Long = 120): JsonObject = checkNotNull(active).receive(timeoutSeconds)
    override fun close() { closed = true; active?.close() }
}

/** Scanning is the user's consent; all secrets then travel inside the QR-authenticated tunnel. */
suspend fun pairDesktop(http: OkHttpClient, qr: CentralPairCode, name: String): CentralCredential {
    require(qr.version == 2) { "Refresh the QR code in the desktop app" }
    require(qr.expiresAt > System.currentTimeMillis()) { "Pairing code expired" }
    require(name.isNotBlank() && name.length <= 80)
    for (origin in qr.lanOrigins.filter(::onLocalNetwork)) {
        val result = withContext(Dispatchers.IO) {
            runCatching {
                RemoteSocket(http, origin.replaceFirst("http", "ws") + "/v1/lan",
                    remoteObject("type" to "auth", "computerId" to qr.computerId, "inviteId" to qr.localInviteId), qr.key).use { t ->
                    t.connect(1800); t.send(remoteObject("type" to "pair", "name" to name))
                    val answer = t.receive(30); check(answer.text("type") == "paired")
                    CentralCredential.decode(answer.getValue("credential").toString()).also {
                        require(it.computerId == qr.computerId && it.key == qr.key)
                        require(it.relay == null || it.relay == qr.relay)
                    }
                }
            }
        }
        result.getOrNull()?.let { return it }
    }
    require(qr.relay.isNotEmpty()) { "Connect the phone and computer to the same Wi-Fi and refresh the QR code" }
    val result = withContext(Dispatchers.IO) { centralPost(http, qr.relay, "claim-qr",
        remoteObject("inviteId" to qr.inviteId, "claimSecret" to qr.claimSecret, "name" to name)) }
    require(result.text("deviceId") == qr.deviceId)
    val credential = CentralCredential.decode(remoteObject("bindingId" to result.text("bindingId"), "bindingToken" to result.text("bindingToken"),
        "key" to qr.key, "computerId" to qr.computerId, "lanOrigins" to JsonArray(qr.lanOrigins.map(::JsonPrimitive)), "relay" to qr.relay).toString())
    try {
        while (System.currentTimeMillis() < qr.expiresAt) {
            val state = withContext(Dispatchers.IO) { centralPost(http, qr.relay, "status", remoteObject("bindingId" to credential.bindingId), credential.bindingToken) }
            if (state.text("state") == "approved") return credential
            check(state.text("state") == "pending") { "Pairing was revoked" }
            delay(750)
        }
        throw IOException("Pairing timed out")
    } catch (e: Exception) {
        withContext(Dispatchers.IO) { runCatching { centralPost(http, qr.relay, "unbind", remoteObject("bindingId" to credential.bindingId), credential.bindingToken) } }
        throw e
    }
}

/** True means the computer or its relay accepted revocation; false must remain queued offline. */
fun unbindDesktop(http: OkHttpClient, origin: String, credential: CentralCredential): Boolean {
    if (credential.computerId != null && credential.lanOrigins.any(::onLocalNetwork)) {
        val local = credential.copy(bindingToken = "", relay = null)
        if (runCatching {
            CentralTunnel(http, "", local).use { t ->
                t.connect(); t.send(remoteObject("type" to "binding_unbind"))
                check(t.receive(15).text("type") == "binding_unbound")
            }
        }.isSuccess) return true
    }
    val relay = credential.relay ?: origin.takeIf { credential.computerId == null } ?: return false
    return runCatching { centralPost(http, relay, "unbind", remoteObject("bindingId" to credential.bindingId), credential.bindingToken); true }.getOrDefault(false)
}

class CentralRpcTransport(private val origin: String, private val http: OkHttpClient, private val credential: CentralCredential) : RpcTransport {
    /** Match RpcTransport's failure contract so a dropped tunnel becomes a UI error. */
    private suspend fun <T> exchange(block: () -> T): T = withContext(Dispatchers.IO) {
        try { block() }
        catch (e: CancellationException) { throw e }
        catch (e: RpcTransportException) { throw e }
        catch (e: IOException) { throw RpcTransportException(0, "Remote connection failed", e) }
        catch (e: IllegalStateException) { throw RpcTransportException(0, "Remote protocol failed", e) }
    }
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
    private fun response(t: CentralTunnel, head: JsonObject, limit: Int = 16 * 1024 * 1024): RpcHttpResponse {
        val data = stream(t).remoteReadLimited(limit + 1)
        if (data.size > limit) throw RpcTransportException(413, carrierMessage(413))
        val type = head["contentType"]?.jsonPrimitive?.contentOrNull
        return if (type?.startsWith("multipart/") == true) RpcHttpResponse(200, "", type, data) else RpcHttpResponse(200, data.toString(Charsets.UTF_8), type)
    }
    override suspend fun post(path: String, body: String): RpcHttpResponse = exchange {
        // Office rendering returns one multipart PDF. Other files are read in bounded windows.
        val limit = if (path == "/api/officeToPdf/render") 32 * 1024 * 1024 + 65536 else 16 * 1024 * 1024
        CentralTunnel(http, origin, credential).use { t -> val bytes = body.toByteArray(); response(t, start(t, path, "POST", "application/json", bytes.size.toLong(), bytes.inputStream(), null), limit) }
    }
    override suspend fun <T> download(path: String, consume: (String?, String?, InputStream) -> T): T = exchange {
        CentralTunnel(http, origin, credential).use { t -> val h = start(t, path, "GET", "application/octet-stream", 0, null, null); consume(h["contentType"]?.jsonPrimitive?.contentOrNull, h["contentDisposition"]?.jsonPrimitive?.contentOrNull, stream(t)) }
    }
    override suspend fun upload(path: String, contentType: String, contentLength: Long, body: InputStream, onProgress: ((Long) -> Unit)?): RpcHttpResponse = exchange {
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
