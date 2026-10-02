package com.labteto.dshmobile.core.wire

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

class CollaborationRelayTest {
    private fun server(handler: (HttpExchange) -> Unit) = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        .also { it.createContext("/", handler); it.start() }
    private fun origin(s: HttpServer) = "http://127.0.0.1:${s.address.port}"
    private fun reply(e: HttpExchange, status: Int, body: String) {
        e.requestBody.readBytes(); val bytes = body.toByteArray()
        e.sendResponseHeaders(status, bytes.size.toLong()); e.responseBody.use { it.write(bytes) }
    }
    private fun health() = """{"ok":true,"protocol":"dsh-desktop-remote-v1","relayId":"relay_collab_test"}"""
    private val token = "fixture-collaboration-grant-no-real-credentials"

    @Test fun privateIdentityMismatchFallsBackToPublicWithoutLeakingCredentialsAndNoDesktopTunnel() = runBlocking {
        val wrongCalls = CopyOnWriteArrayList<String>()
        val calls = CopyOnWriteArrayList<String>()
        var revoked = false
        val public = server { e ->
            calls += e.requestURI.path
            when (e.requestURI.path) {
                "/health" -> { assertNull(e.requestHeaders.getFirst("Authorization")); reply(e, 200, health()) }
                "/v1/collab-token" -> {
                    assertEquals("Bearer fixture_binding_token", e.requestHeaders.getFirst("Authorization"))
                    reply(e, 200, """{"token":"$token","expiresAt":${System.currentTimeMillis() + 300000}}""")
                }
                "/collab/v1/tasks/task_test" -> {
                    assertEquals("Bearer $token", e.requestHeaders.getFirst("Authorization"))
                    reply(e, if (revoked) 403 else 200, if (revoked) "{}" else """{"task":{"id":"task_test","title":"Desktop is offline"}}""")
                }
                else -> reply(e, 404, "{}")
            }
        }
        val private = server { e -> wrongCalls += e.requestURI.path; assertNull(e.requestHeaders.getFirst("Authorization")); reply(e, 200, health().replace("relay_collab_test", "untrusted_relay")) }
        val http = OkHttpClient()
        try {
            val routes = RelayRoutes("relay_collab_test", listOf(RelayEndpoint(origin(public), "public"), RelayEndpoint(origin(private), "private")))
            val client = CollaborationRelay(http, origin(public), CentralCredential("binding_test", "fixture_binding_token", CentralCrypto.random(), "computer_test", relay = origin(public), relayRoutes = routes))
            assertEquals("Desktop is offline", client.request("tasks/task_test").getValue("task").jsonObject.text("title"))
            assertEquals(listOf("/health"), wrongCalls.toList())
            assertEquals(listOf("/health", "/v1/collab-token", "/collab/v1/tasks/task_test"), calls.toList())
            revoked = true
            val error = runCatching { client.request("tasks/task_test") }.exceptionOrNull()
            assertTrue(error is RpcTransportException && error.status == 403)
            assertFalse(calls.any { it.contains("tunnel") })
        } finally { public.stop(0); private.stop(0); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
    }

    @Test fun privateEntryWorksAloneAndReadMarkersPreserveTaskScope() = runBlocking {
        val publicCalls = CopyOnWriteArrayList<String>()
        var marker = ""
        val private = server { e -> when (e.requestURI.path) {
            "/health" -> reply(e, 200, health())
            "/v1/collab-token" -> reply(e, 200, """{"token":"$token","expiresAt":${System.currentTimeMillis() + 300000}}""")
            "/collab/v1/inbox/read" -> { marker = e.requestBody.readBytes().toString(Charsets.UTF_8); reply(e, 200, """{"unread":1}""") }
            else -> reply(e, 404, "{}")
        } }
        val public = server { e -> publicCalls += e.requestURI.path; reply(e, 503, "{}") }
        val http = OkHttpClient()
        try {
            val routes = RelayRoutes("relay_collab_test", listOf(RelayEndpoint(origin(public), "public"), RelayEndpoint(origin(private), "private")))
            val client = CollaborationRelay(http, origin(private), CentralCredential("binding_test", "fixture_binding_token", CentralCrypto.random(), "computer_test", relay = origin(private), relayRoutes = routes))
            assertEquals(1, client.request("inbox/read", buildJsonObject { put("taskId", "task_test"); put("through", 42) }).getValue("unread").jsonPrimitive.int)
            assertEquals("task_test", Json.parseToJsonElement(marker).jsonObject.text("taskId"))
            assertTrue(publicCalls.isEmpty())
        } finally { private.stop(0); public.stop(0); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
    }
}
