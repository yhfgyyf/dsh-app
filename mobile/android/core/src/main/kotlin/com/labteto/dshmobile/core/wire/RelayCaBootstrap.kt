package com.labteto.dshmobile.core.wire

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

data class RelayCaCertificate(val pem: String, val fingerprint: String) {
    val fileName: String get() = "DSH-Relay-CA-${fingerprint.take(12)}.crt"
}

class RelayCaRequiredException(val certificate: RelayCaCertificate) : IOException("Install the relay CA before pairing")
class RelayCaPinMissingException(cause: Throwable) : IOException("The desktop QR does not include a CA fingerprint", cause)
class RelayCaVerificationException(cause: Throwable) : IOException("The relay CA could not be verified against the desktop QR", cause)

internal fun certificateFingerprint(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }

private fun trustManagerFor(certificate: X509Certificate): X509TrustManager {
    val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("relay", certificate) }
    return TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        .trustManagers.filterIsInstance<X509TrustManager>().single()
}

/** The desktop QR is the trust source. This socket exchanges TLS certificates only, never pairing secrets. */
private class DownloadTrustManager(private val fingerprint: String) : X509TrustManager {
    var certificate: X509Certificate? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty() || chain.size > 16 || chain.any { it.encoded.size > 16384 }) {
            throw CertificateException("Invalid relay certificate chain")
        }
        val root = chain.firstOrNull { certificateFingerprint(it) == fingerprint }
            ?: throw CertificateException("Relay CA fingerprint does not match the QR")
        if (root.basicConstraints < 0 || root.subjectX500Principal != root.issuerX500Principal) {
            throw CertificateException("The QR must identify a root CA")
        }
        root.checkValidity()
        root.verify(root.publicKey)
        trustManagerFor(root).checkServerTrusted(chain, authType)
        certificate = root
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not used")
    }
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

private fun retrieveRelayCa(origin: String, fingerprint: String): X509Certificate {
    require(fingerprint.matches(Regex("[a-f0-9]{64}")))
    val url = origin.toHttpUrl()
    require(url.isHttps)
    val manager = DownloadTrustManager(fingerprint)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
    Socket().use { connection ->
        connection.connect(InetSocketAddress(url.host, url.port), 1500)
        (context.socketFactory.createSocket(connection, url.host, url.port, true) as SSLSocket).use { socket ->
            socket.soTimeout = 1500
            socket.startHandshake()
        }
    }
    return manager.certificate ?: throw CertificateException("The relay did not provide its root CA")
}

private fun verifiedDownload(origin: String, fingerprint: String, routes: RelayRoutes?): RelayCaCertificate {
    val certificate = retrieveRelayCa(origin, fingerprint)
    val manager = trustManagerFor(certificate)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(manager), null) }
    // A separate, credential-free client keeps normal hostname checks and does not change app trust.
    val client = OkHttpClient.Builder().sslSocketFactory(context.socketFactory, manager)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .callTimeout(1500, TimeUnit.MILLISECONDS).build()
    try { checkRelayHealth(client, origin, routes) }
    finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    val encoded = Base64.getMimeEncoder(64, byteArrayOf(10)).encodeToString(certificate.encoded)
    return RelayCaCertificate("-----BEGIN CERTIFICATE-----\n$encoded\n-----END CERTIFICATE-----\n", fingerprint)
}

internal fun selectPairingRelay(http: OkHttpClient, qr: CentralPairCode): String {
    val untrusted = mutableListOf<Pair<String, SSLHandshakeException>>()
    var failure: Exception = IOException("No reachable relay matches the scanned QR")
    for (origin in relayOrigins(qr.relay, qr.relayRoutes)) {
        try {
            if (origin.startsWith("https://")) checkRelayHealth(http, origin, qr.relayRoutes)
            else checkRelayIdentity(http, origin, qr.relayRoutes)
            return origin
        } catch (e: SSLHandshakeException) { untrusted += origin to e; failure = e }
        catch (e: Exception) { failure = e }
    }
    if (untrusted.isEmpty()) throw failure
    val fingerprint = qr.relayCaFingerprint ?: throw RelayCaPinMissingException(untrusted.first().second)
    for ((origin, _) in untrusted) {
        try { throw RelayCaRequiredException(verifiedDownload(origin, fingerprint, qr.relayRoutes)) }
        catch (e: RelayCaRequiredException) { throw e }
        catch (e: Exception) { failure = e }
    }
    throw RelayCaVerificationException(failure)
}
