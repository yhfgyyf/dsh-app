package com.labteto.dshmobile.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import com.labteto.dshmobile.core.wire.CentralCredential
import com.labteto.dshmobile.core.wire.unbindDesktop
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import javax.inject.Inject
import javax.inject.Singleton

/** Phone-side revocation survives offline use and process restarts. */
@Singleton
class RemoteBindings @Inject constructor(
    private val hosts: HostsStore,
    private val credentials: RelayCredentialStore,
    private val http: OkHttpClient,
    @ApplicationContext private val context: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var started = false
    val pendingCount = credentials.pendingUnbindCount

    fun start() {
        if (started) return
        started = true
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { scope.launch { runCatching { flush() } } }
            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) { scope.launch { runCatching { flush() } } }
        }
        runCatching { context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback) }
        scope.launch { while (true) { runCatching { flush() }; delay(60_000) } }
    }

    suspend fun unbind(host: HostConfig) {
        if (host.centralRelay) {
            credentials.token(host.id)?.let { raw ->
                val credential = CentralCredential.decode(raw)
                val payload = buildJsonObject { put("origin", host.baseUrl); put("credential", raw) }
                credentials.queueUnbind(credential.bindingId, payload.toString())
            }
        }
        hosts.removeHost(host.id)
        scope.launch { runCatching { flush() } }
    }

    suspend fun flush() = lock.withLock {
        for ((id, payload) in credentials.pendingUnbinds()) {
            val accepted = runCatching {
                val value = Json.parseToJsonElement(payload).jsonObject
                unbindDesktop(http, value.getValue("origin").jsonPrimitive.content,
                    CentralCredential.decode(value.getValue("credential").jsonPrimitive.content))
            }.getOrDefault(false)
            if (accepted) credentials.completeUnbind(id)
        }
    }
}
