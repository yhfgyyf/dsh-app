package com.labteto.dshmobile.core.wire

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsServer
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import org.junit.Assume.assumeNotNull

class RelayCaBootstrapTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "services/relay/test/fixtures/ca/ca.pem").exists() }
    private val fixtures = File(root, "services/relay/test/fixtures/ca")
    private fun certificate(name: String) = File(fixtures, name).inputStream().use {
        CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
    }
    private fun client(ca: X509Certificate? = null): OkHttpClient {
        if (ca == null) return OkHttpClient()
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("ca", ca) }
        val manager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
            .trustManagers.filterIsInstance<X509TrustManager>().single()
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
        return OkHttpClient.Builder().sslSocketFactory(context.socketFactory, manager).build()
    }
    private fun close(http: OkHttpClient) { http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }

    private inner class Fixture(includeRoot: Boolean = true, expired: Boolean = false) : AutoCloseable {
        val ca = certificate(if (expired) "expired-ca.pem" else "ca.pem")
        val requests = CopyOnWriteArrayList<String>()
        val server = HttpsServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val origin get() = "https://127.0.0.1:${server.address.port}"
        init {
            val keyText = File(fixtures, if (expired) "expired-ca-key.pem" else "server-key.pem").readText()
                .replace(Regex("-----[^-]+-----|\\s"), "")
            val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(keyText)))
            val chain = if (expired) arrayOf(ca) else if (includeRoot) arrayOf(certificate("server.pem"), ca) else arrayOf(certificate("server.pem"))
            val keys = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setKeyEntry("server", key, charArrayOf(), chain) }
            val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, charArrayOf()) }
            server.httpsConfigurator = HttpsConfigurator(SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) })
            server.createContext("/") { exchange ->
                val path = exchange.requestURI.path
                requests += path
                exchange.requestBody.readBytes()
                val response = when (path) {
                    "/health" -> {
                        assertNull(exchange.requestHeaders.getFirst("Authorization"))
                        """{"ok":true,"protocol":"dsh-desktop-remote-v1","relayId":"relay_test"}"""
                    }
                    "/v1/claim-qr" -> """{"bindingId":"binding_test","bindingToken":"binding_token_test","deviceId":"desktop_test"}"""
                    "/v1/status" -> """{"state":"approved"}"""
                    else -> "{}"
                }.toByteArray()
                exchange.sendResponseHeaders(200, response.size.toLong())
                exchange.responseBody.use { it.write(response) }
            }
            server.start()
        }
        fun code() = CentralPairCode(origin, "desktop_test", "Computer", "invite_test", "claim_secret_test", CentralCrypto.random(),
            System.currentTimeMillis() + 120000, version = 2,
            relayRoutes = RelayRoutes("relay_test", listOf(RelayEndpoint(origin, "public"))), relayCaFingerprint = certificateFingerprint(ca))
        override fun close() { server.stop(0) }
    }

    @Test fun missingCaDownloadsThePinnedRootBeforeAnyClaimAndPairingResumesAfterTrust() = runBlocking {
        Fixture().use { fixture ->
            val untrusted = client()
            val qr = fixture.code()
            try {
                val required = assertThrows(RelayCaRequiredException::class.java) { runBlocking { pairDesktop(untrusted, qr, "Phone") } }
                assertEquals(qr.relayCaFingerprint, required.certificate.fingerprint)
                val parsed = CertificateFactory.getInstance("X.509").generateCertificate(required.certificate.pem.byteInputStream()) as X509Certificate
                assertEquals(qr.relayCaFingerprint, certificateFingerprint(parsed))
                assertEquals(listOf("/health"), fixture.requests.toList())
                // Cancelling installation leaves no binding or claim at the server.
                assertFalse(fixture.requests.contains("/v1/claim-qr"))
                val trusted = client(parsed)
                try {
                    assertEquals("binding_test", pairDesktop(trusted, qr, "Phone").bindingId)
                    assertEquals(1, fixture.requests.count { it == "/v1/claim-qr" })
                } finally { close(trusted) }
            } finally { close(untrusted) }
        }
    }

    @Test fun oldQrWithoutFingerprintDoesNotDownloadOrClaimOnUntrustedTls() = runBlocking {
        Fixture().use { fixture ->
            val http = client()
            try {
                assertThrows(RelayCaPinMissingException::class.java) { runBlocking { pairDesktop(http, fixture.code().copy(relayCaFingerprint = null), "Phone") } }
                assertTrue(fixture.requests.isEmpty())
            } finally { close(http) }
        }
    }

    @Test fun missingRelayCaIsHandledBeforeTryingAnAvailableLanRoute() = runBlocking {
        val address = NetworkInterface.getNetworkInterfaces().toList().flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is java.net.Inet4Address && it.isSiteLocalAddress }?.hostAddress
        assumeNotNull(address)
        val lan = HttpServer.create(InetSocketAddress(address, 0), 0)
        val requests = CopyOnWriteArrayList<String>()
        lan.createContext("/") { exchange -> requests += exchange.requestURI.path; exchange.sendResponseHeaders(426, -1); exchange.close() }
        lan.start()
        Fixture().use { fixture ->
            val http = client()
            try {
                val origin = "http://$address:${lan.address.port}"
                assertTrue(onLocalNetwork(origin))
                val qr = fixture.code().copy(lanOrigins = listOf(origin), localInviteId = "local_invite")
                assertThrows(RelayCaRequiredException::class.java) { runBlocking { pairDesktop(http, qr, "Phone") } }
                assertTrue("LAN must wait for relay CA installation", requests.isEmpty())
                assertEquals(listOf("/health"), fixture.requests.toList())
            } finally { close(http); lan.stop(0) }
        }
    }

    @Test fun wrongFingerprintIncompleteChainAndExpiredCaSendNoHttpRequests() = runBlocking {
        for (kind in listOf("wrong", "incomplete", "expired")) Fixture(includeRoot = kind != "incomplete", expired = kind == "expired").use { fixture ->
            val http = client()
            try {
                val qr = fixture.code().let { if (kind == "wrong") it.copy(relayCaFingerprint = "0".repeat(64)) else it }
                assertThrows(RelayCaVerificationException::class.java) { runBlocking { pairDesktop(http, qr, "Phone") } }
                assertTrue("$kind must send no HTTP request", fixture.requests.isEmpty())
            } finally { close(http) }
        }
    }

    @Test fun matchingCaStillRequiresTheRelayHostname() = runBlocking {
        Fixture().use { fixture ->
            val http = client()
            try {
                val wrongHost = fixture.origin.replace("127.0.0.1", "localhost")
                val qr = fixture.code().copy(relay = wrongHost, relayRoutes = RelayRoutes("relay_test", listOf(RelayEndpoint(wrongHost, "public"))))
                assertThrows(RelayCaVerificationException::class.java) { runBlocking { pairDesktop(http, qr, "Phone") } }
                assertTrue(fixture.requests.isEmpty())
            } finally { close(http) }
        }
    }

    @Test fun qrFingerprintIsOptionalButMustBeAHexStringForHttps() {
        val relay = remoteObject("origin" to "https://relay.example", "deviceId" to "desktop_test", "inviteId" to "invite_test", "claimSecret" to "claim_test")
        val base = remoteObject("kind" to "dsh-desktop-pair", "version" to 2, "computerId" to "computer_test", "name" to "Computer",
            "key" to CentralCrypto.random(), "expiresAt" to System.currentTimeMillis() + 120000, "relay" to relay)
        fun parse(value: JsonElement?) = CentralPairCode.parse(JsonObject(base + ("relay" to JsonObject(relay +
            (value?.let { mapOf("caFingerprint" to it) } ?: emptyMap())))).toString())
        assertNotNull(parse(null))
        assertEquals("a".repeat(64), parse(JsonPrimitive("A".repeat(64)))?.relayCaFingerprint)
        assertNull(parse(JsonPrimitive("bad")))
        assertNull(parse(JsonPrimitive(1234)))
    }
}
