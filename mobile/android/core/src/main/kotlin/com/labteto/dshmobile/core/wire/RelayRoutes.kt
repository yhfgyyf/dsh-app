package com.labteto.dshmobile.core.wire

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.CookieJar

data class RelayEndpoint(val origin: String, val network: String)

/** The QR authorizes a bounded set of aliases of one relay, not arbitrary fallback hosts. */
data class RelayRoutes(val id: String, val endpoints: List<RelayEndpoint>) {
    fun encode(): JsonObject = remoteObject("id" to id, "endpoints" to JsonArray(endpoints.map {
        remoteObject("origin" to it.origin, "network" to it.network)
    }))

    companion object {
        fun decode(value: JsonElement?): RelayRoutes? {
            if (value == null) return null
            val o = value.jsonObject
            val id = o.text("id")
            require(id.matches(Regex("[A-Za-z0-9_-]{8,128}")))
            val entries = o.getValue("endpoints").jsonArray
            require(entries.size in 1..6)
            val endpoints = entries.map {
                val entry = it.jsonObject
                val origin = entry.text("origin")
                val network = entry.text("network")
                require(origin.length <= 256 && origin.none { c -> c.isWhitespace() || c == '\\' })
                require(network in setOf("private", "public"))
                RelayEndpoint(centralOrigin(origin), network)
            }
            require(endpoints.map { it.origin }.distinct().size == endpoints.size)
            return RelayRoutes(id, endpoints)
        }
    }
}

internal fun relayOrigins(legacy: String?, routes: RelayRoutes?): List<String> =
    routes?.endpoints?.sortedBy { if (it.network == "private") 0 else 1 }?.map { it.origin }
        ?: listOfNotNull(legacy?.takeIf { it.isNotEmpty() })

internal const val RELAY_ATTEMPT_MS = 3500L
internal fun relayDeadline(): Long = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(RELAY_ATTEMPT_MS)
internal fun relayTimeLeft(deadline: Long): Long =
    TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).also { if (it <= 0) throw IOException("Relay connection timed out") }

/** No credential, redirect, cookie or application payload is needed to check an alias. */
internal fun checkRelayIdentity(http: OkHttpClient, origin: String, routes: RelayRoutes?, timeoutMs: Long = 1500) {
    if (routes == null) return // Existing single-origin relays have no identity endpoint.
    // A stale pooled socket may be retried for this read-only GET, never for a single-use claim.
    val client = http.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(true).cookieJar(CookieJar.NO_COOKIES)
        .callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
    client.newCall(Request.Builder().url(centralOrigin(origin) + "/health").build()).execute().use { response ->
        if (response.code != 200) throw IOException("Relay identity check failed (${response.code})")
        val bytes = response.body?.byteStream()?.remoteReadLimited(4097) ?: throw IOException("Empty relay identity")
        require(bytes.size <= 4096)
        val health = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        require(health["ok"]?.jsonPrimitive?.booleanOrNull == true && health.text("protocol") == "dsh-desktop-remote-v1" &&
            health.text("relayId") == routes.id) { "Relay identity does not match the scanned QR" }
    }
}

/** Only these idempotent binding operations may move to another authorized alias after a failure. */
internal fun bindingPost(http: OkHttpClient, legacy: String?, routes: RelayRoutes?, path: String, body: JsonObject, token: String): JsonObject {
    require(path in setOf("status", "unbind"))
    var failure: Exception = IOException("No reachable relay")
    for (origin in relayOrigins(legacy, routes)) {
        try {
            val deadline = relayDeadline()
            checkRelayIdentity(http, origin, routes)
            return centralPost(http, origin, path, body, token, if (routes == null) 15000 else relayTimeLeft(deadline))
        } catch (e: Exception) { failure = e }
    }
    throw failure
}
