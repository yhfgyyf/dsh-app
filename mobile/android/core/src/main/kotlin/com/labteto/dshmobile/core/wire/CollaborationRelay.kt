package com.labteto.dshmobile.core.wire

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** The collaboration service is independent of the desktop tunnel. No Play Services are used. */
class CollaborationRelay(http: OkHttpClient, origin: String, private val credential: CentralCredential) {
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES).callTimeout(15, TimeUnit.SECONDS).build()
    private val legacy = credential.relay ?: origin.takeIf { credential.computerId == null }
    private val mutex = Mutex()
    private data class Grant(val origin: String, val token: String, val expiresAt: Long)
    private var cached: Grant? = null

    private suspend fun grant(): Grant = mutex.withLock {
        cached?.takeIf { it.expiresAt > System.currentTimeMillis() + 30_000 } ?: withContext(Dispatchers.IO) {
            check(credential.bindingToken.isNotBlank()) { "This binding has no relay credential" }
            var failure: Exception = IOException("No reachable collaboration relay")
            for (candidate in relayOrigins(legacy, credential.relayRoutes)) {
                try {
                    checkRelayIdentity(http, candidate, credential.relayRoutes)
                    val reply = centralPost(http, candidate, "collab-token",
                        remoteObject("bindingId" to credential.bindingId), credential.bindingToken, RELAY_ATTEMPT_MS)
                    val token = reply.text("token")
                    val expiresAt = reply.getValue("expiresAt").jsonPrimitive.long
                    require(token.length in 32..2048 && expiresAt > System.currentTimeMillis())
                    return@withContext Grant(candidate, token, expiresAt).also { cached = it }
                } catch (e: Exception) {
                    // An authenticated refusal must not be hidden by a different alias.
                    if (e is RpcTransportException && e.status in setOf(401, 403)) throw e
                    failure = e
                }
            }
            throw failure
        }
    }

    suspend fun request(path: String, body: JsonObject? = null): JsonObject {
        require(path.matches(Regex("[A-Za-z0-9_/?=&%.-]+")) && !path.contains("..") && !path.startsWith('/'))
        val current = grant()
        try {
            return withContext(Dispatchers.IO) {
                val builder = Request.Builder().url(current.origin + "/collab/v1/" + path)
                    .header("Authorization", "Bearer ${current.token}")
                if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
                http.newCall(builder.build()).execute().use { response ->
                    if (!response.isSuccessful) throw RpcTransportException(response.code, "Collaboration request failed (${response.code})")
                    val bytes = response.body?.byteStream()?.remoteReadLimited(12 * 1024 * 1024 + 1)
                        ?: throw IOException("Empty collaboration response")
                    require(bytes.size <= 12 * 1024 * 1024)
                    Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                }
            }
        } catch (e: Exception) {
            mutex.withLock { if (cached === current) cached = null }
            throw e
        }
    }

    /** Frames are invalidation hints; the durable inbox is the source of messages. */
    fun changes(): Flow<Unit> = callbackFlow {
        val current = grant()
        val socket = http.newBuilder().pingInterval(25, TimeUnit.SECONDS).build().newWebSocket(
            Request.Builder().url(current.origin.replaceFirst("http", "ws") + "/collab/v1/events").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(remoteObject("type" to "auth", "token" to current.token).toString())
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        require(text.length <= 65536)
                        val kind = Json.parseToJsonElement(text).jsonObject.text("type")
                        if (kind == "ready" || kind == "changed") trySend(Unit)
                    } catch (e: Exception) { close(e); webSocket.cancel() }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close(IOException("Collaboration connection closed ($code)")) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { close(t) }
            },
        )
        val renewal = launch {
            delay((current.expiresAt - System.currentTimeMillis() - 25_000).coerceAtLeast(1000))
            close()
        }
        awaitClose { renewal.cancel(); socket.cancel() }
    }.conflate()
}
