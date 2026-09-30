package com.labteto.dshmobile.conformance

import com.labteto.dshmobile.core.wire.DshApiClient
import com.labteto.dshmobile.core.wire.HarnessSession
import com.labteto.dshmobile.core.wire.OkHttpRpcTransport
import com.labteto.dshmobile.core.wire.RemoteStreamMux
import com.labteto.dshmobile.core.wire.SessionExchange
import com.labteto.dshmobile.core.wire.WsChannel
import com.labteto.dshmobile.core.wire.dto.REMOTE_STREAM_MUX_PATH
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * The shipped client, pointed at a real harness.
 *
 * Nothing here re-describes the protocol: the authentication, the envelopes, the mux and the fold
 * are all `:core` as the app ships it. The only thing this adds is the launch-token exchange, which
 * on a phone is a person pasting the harness's startup line and here is one call — and which is
 * itself worth exercising, because `:mock-harness` implements no `GET /?token=` at all, so the
 * direct-connection authentication tier every non-relay user is on has never had an end-to-end test.
 */
class HarnessClient(harness: HarnessProcess) : AutoCloseable {

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        // The mux is a long-lived socket; the harness pings it every two seconds and OkHttp answers
        // at the protocol layer, so no read deadline may apply to it.
        .pingInterval(0, TimeUnit.SECONDS)
        .build()

    /** The browser-session cookie this client exchanged its launch token for. */
    val cookie: String = runBlocking {
        when (val result = HarnessSession.exchange(harness.baseUrl, harness.launchToken, http)) {
            is SessionExchange.Granted -> result.cookie
            else -> error("the harness refused the launch token: $result")
        }
    }

    val baseUrl: String = harness.baseUrl

    /** The unary half, authenticated. */
    val api: DshApiClient = DshApiClient(
        OkHttpRpcTransport(harness.baseUrl, http, cookie = cookie),
    )

    /** The stream half. One socket, as the app opens one. */
    val mux: RemoteStreamMux = RemoteStreamMux { sink ->
        WsChannel(
            url = harness.baseUrl + REMOTE_STREAM_MUX_PATH,
            client = http,
            sink = sink,
            cookie = cookie,
        )
    }

    /** An unauthenticated client against the same harness, for the 401 and fence cases. */
    fun anonymous(): DshApiClient = DshApiClient(OkHttpRpcTransport(baseUrl, http))

    override fun close() {
        runCatching { mux.close() }
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }
}
