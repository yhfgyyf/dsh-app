package com.labteto.dshmobile.connection

import com.labteto.dshmobile.core.wire.CentralCredential
import com.labteto.dshmobile.core.wire.CentralRpcTransport
import com.labteto.dshmobile.core.wire.CentralWsChannel
import com.labteto.dshmobile.core.wire.DshApiClient
import com.labteto.dshmobile.core.wire.OkHttpRpcTransport
import com.labteto.dshmobile.core.wire.RelayTls
import com.labteto.dshmobile.core.wire.RemoteStreamMux
import com.labteto.dshmobile.core.wire.WsChannel
import com.labteto.dshmobile.core.wire.dto.REMOTE_STREAM_MUX_PATH
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The one place a [DshApiClient] is built.
 *
 * Three facts have to agree for a call to reach a relay at all — the scheme, the certificate pin and
 * the bearer token — and they have to agree across the unary transport *and* the mux upgrade,
 * because the connection loop needs both to succeed inside one 3000ms generation. A relay refuses
 * an upgrade that arrives without the header, and the loop can only report that as a stream that
 * would not open. Splitting the assembly across the manager and the discovery engine is how one of
 * the three quietly goes missing, so it happens here or nowhere.
 *
 * Harness 0.1.2 reduced two downlink sockets to one, so there is a single [RemoteStreamMux] per
 * connection generation rather than a socket factory the client calls twice.
 */
@Singleton
class HarnessClientFactory @Inject constructor(
    private val okHttpClient: OkHttpClient,
    private val credentials: RelayCredentialStore,
    private val sessions: HarnessSessionStore,
) {
    /**
     * Pinned clients, one per fingerprint.
     *
     * Each carries its own `SSLContext` and connection pool, so building one per request would
     * throw away every kept-alive connection — the resident mux socket included. There is one
     * relay in play at a time and the key is a base64 hash, so the map never grows meaningfully.
     */
    private val pinned = ConcurrentHashMap<String, OkHttpClient>()

    /**
     * The HTTP client to reach [fingerprint]'s relay with, or the shared one when nothing is pinned.
     *
     * A null fingerprint means plaintext or a certificate the platform already trusts; both are
     * served correctly by the default trust store.
     */
    fun httpClient(fingerprint: String?): OkHttpClient =
        if (fingerprint == null) okHttpClient
        else pinned.getOrPut(fingerprint) { RelayTls.pinnedClient(okHttpClient, fingerprint) }

    /** The `Authorization` value for [config], or null when it is not a paired relay. */
    suspend fun authorizationFor(config: HostConfig): String? =
        if (config.isRelay && !config.centralRelay) credentials.authorization(config.id) else null

    /**
     * The harness browser session for [config], or null.
     *
     * Only for a direct connection. Behind a relay the relay holds the harness session and
     * injects it upstream, so sending one from here would put the host's own credential on the
     * network — and the relay strips the header anyway.
     */
    private suspend fun cookieFor(config: HostConfig): String? =
        if (config.isRelay) null else sessions.cookie(config.id)

    /**
     * A client for [config], carrying whatever credential and pin that endpoint needs.
     *
     * [timeouts] is for probes; the live connection takes the transport's own 30s defaults, because
     * a long `session/page` on a big session is not a stalled request.
     */
    suspend fun clientFor(config: HostConfig, timeouts: ProbeTimeouts? = null): DshApiClient {
        val http = httpClient(config.relayFingerprint)
        if (config.centralRelay) return DshApiClient(CentralRpcTransport(config.baseUrl, http, CentralCredential.decode(checkNotNull(credentials.token(config.id)))))
        val authorization = authorizationFor(config)
        val base = config.baseUrl
        return DshApiClient(
            transport = OkHttpRpcTransport(
                baseUrl = base,
                client = http,
                connectTimeoutMs = timeouts?.connectMs ?: DEFAULT_TIMEOUT_MS,
                readTimeoutMs = timeouts?.readMs ?: DEFAULT_TIMEOUT_MS,
                authorization = authorization,
                cookie = cookieFor(config),
            ),
        )
    }

    /**
     * The mux carrying every stream of one connection generation.
     *
     * Separate from [clientFor] because its lifetime is the generation's, not the client's: the
     * connection loop builds a new one per attempt and closes it when the generation ends, while
     * the unary client outlives both.
     */
    suspend fun muxFor(config: HostConfig): RemoteStreamMux {
        val http = httpClient(config.relayFingerprint)
        if (config.centralRelay) {
            val credential = CentralCredential.decode(checkNotNull(credentials.token(config.id)))
            return RemoteStreamMux { sink -> CentralWsChannel(config.baseUrl, http, credential, sink) }
        }
        val authorization = authorizationFor(config)
        val base = config.baseUrl
        val cookie = cookieFor(config)
        return RemoteStreamMux { sink ->
            WsChannel("$base$REMOTE_STREAM_MUX_PATH", http, sink, authorization, cookie)
        }
    }

    /**
     * A client for an address nothing is remembered about yet — the LAN sweep and the manual field.
     *
     * Deliberately unauthenticated: an address that has not been paired has no credential to send,
     * and a relay answers such a probe with the 403 that routes the user to pairing.
     */
    fun anonymousClient(baseUrl: String, timeouts: ProbeTimeouts): DshApiClient = DshApiClient(
        transport = OkHttpRpcTransport(
            baseUrl = baseUrl,
            client = okHttpClient,
            connectTimeoutMs = timeouts.connectMs,
            readTimeoutMs = timeouts.readMs,
        ),
    )

    private companion object {
        /** The transport's own default, restated so a null [ProbeTimeouts] is explicit rather than magic. */
        const val DEFAULT_TIMEOUT_MS = 30_000L
    }
}
