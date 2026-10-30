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

class RelayRoutesTest {
    private fun server(handler: (HttpExchange) -> Unit): HttpServer =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { it.createContext("/", handler); it.start() }
    private fun origin(server: HttpServer) = "http://127.0.0.1:${server.address.port}"
    private fun reply(exchange: HttpExchange, status: Int, body: String) {
        exchange.requestBody.readBytes()
        val bytes = body.toByteArray()
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }
    private fun health(id: String) = """{"ok":true,"protocol":"dsh-desktop-remote-v1","relayId":"$id"}"""
    private fun code(routes: RelayRoutes) = CentralPairCode(routes.endpoints.first().origin, "desktop_test", "Computer", "invite_test",
        "claim_secret_test", CentralCrypto.random(), System.currentTimeMillis() + 120000, version = 2, relayRoutes = routes)

    @Test fun routesAreExplicitAndKeepStablePrivateThenPublicOrder() {
        val routes = RelayRoutes("relay_test", listOf(RelayEndpoint("https://203.0.113.9:9443", "public"),
            RelayEndpoint("https://10.80.0.9:8443", "private"), RelayEndpoint("https://10.90.0.9:8443", "private")))
        assertEquals(routes, RelayRoutes.decode(routes.encode()))
        assertEquals(listOf("https://10.80.0.9:8443", "https://10.90.0.9:8443", "https://203.0.113.9:9443"), relayOrigins("https://internal.invalid", routes))
        assertEquals(listOf("https://legacy.example"), relayOrigins("https://legacy.example", null))
        for (bad in listOf("http://10.1.2.3:8443", "https://u:p@example.test", "https://example.test/path", "https://example.test?x=1", "https://example.test#x", "https://example.test\\evil")) {
            assertThrows(IllegalArgumentException::class.java) { RelayRoutes.decode(RelayRoutes("relay_test", listOf(RelayEndpoint(bad, "private"))).encode()) }
        }
        assertThrows(IllegalArgumentException::class.java) { RelayRoutes.decode(routes.copy(endpoints = listOf(routes.endpoints[0], routes.endpoints[0])).encode()) }
        assertThrows(IllegalArgumentException::class.java) { RelayRoutes.decode(routes.copy(endpoints = emptyList()).encode()) }
        assertThrows(IllegalArgumentException::class.java) { RelayRoutes.decode(routes.copy(endpoints = List(7) { RelayEndpoint("https://10.0.0.${it + 1}", "private") }).encode()) }
        val credential = CentralCredential("binding_test", "binding_token_test", CentralCrypto.random(), "computer_test", relay = routes.endpoints[0].origin, relayRoutes = routes)
        assertEquals(credential, CentralCredential.decode(credential.encode()))
        assertThrows(IllegalArgumentException::class.java) { CentralCredential.decode(credential.copy(relay = "https://not-in-qr.example").encode()) }
    }

    @Test fun identityMismatchAndRedirectReceiveNoPairingCredentials() = runBlocking {
        val wrongRequests = CopyOnWriteArrayList<String>()
        val redirectedRequests = CopyOnWriteArrayList<String>()
        val acceptedRequests = CopyOnWriteArrayList<String>()
        val good = server { exchange ->
            acceptedRequests += exchange.requestURI.path
            when (exchange.requestURI.path) {
                "/health" -> { assertNull(exchange.requestHeaders.getFirst("Authorization")); reply(exchange, 200, health("expected_relay")) }
                "/v1/claim-qr" -> reply(exchange, 201, """{"bindingId":"binding_test","bindingToken":"binding_token_test","deviceId":"desktop_test"}""")
                "/v1/status" -> reply(exchange, 200, """{"state":"approved"}""")
                else -> reply(exchange, 404, "{}")
            }
        }
        val wrong = server { exchange ->
            wrongRequests += exchange.requestURI.path
            assertNull(exchange.requestHeaders.getFirst("Authorization"))
            reply(exchange, 200, health("another_relay"))
        }
        val redirect = server { exchange ->
            redirectedRequests += exchange.requestURI.path
            assertNull(exchange.requestHeaders.getFirst("Authorization"))
            exchange.responseHeaders.add("Location", origin(good) + "/redirect-target")
            reply(exchange, 302, "{}")
        }
        val http = OkHttpClient()
        try {
            val routes = RelayRoutes("expected_relay", listOf(RelayEndpoint(origin(good), "public"), RelayEndpoint(origin(wrong), "private"), RelayEndpoint(origin(redirect), "private")))
            val paired = pairDesktop(http, code(routes), "Phone")
            assertEquals(routes, paired.relayRoutes)
            assertEquals(listOf("/health", "/health"), wrongRequests.toList()) // Selection and approval status.
            assertEquals(listOf("/health", "/health"), redirectedRequests.toList())
            assertEquals(1, acceptedRequests.count { it == "/v1/claim-qr" })
            assertFalse(acceptedRequests.contains("/redirect-target"))
        } finally { listOf(good, wrong, redirect).forEach { it.stop(0) }; http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
    }

    @Test fun ambiguousClaimFailureIsNotReplayedAtAnotherEntry() = runBlocking {
        val privateRequests = CopyOnWriteArrayList<String>()
        val publicRequests = CopyOnWriteArrayList<String>()
        val private = server { exchange ->
            privateRequests += exchange.requestURI.path
            if (exchange.requestURI.path == "/health") reply(exchange, 200, health("expected_relay"))
            else reply(exchange, 503, "{}")
        }
        val public = server { exchange -> publicRequests += exchange.requestURI.path; reply(exchange, 200, health("expected_relay")) }
        val http = OkHttpClient()
        try {
            val routes = RelayRoutes("expected_relay", listOf(RelayEndpoint(origin(private), "private"), RelayEndpoint(origin(public), "public")))
            assertTrue(runCatching { pairDesktop(http, code(routes), "Phone") }.isFailure)
            assertEquals(listOf("/health", "/v1/claim-qr"), privateRequests.toList())
            assertTrue(publicRequests.isEmpty())
        } finally { private.stop(0); public.stop(0); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
    }
}
