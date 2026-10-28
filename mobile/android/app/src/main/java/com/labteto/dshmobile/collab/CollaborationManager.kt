package com.labteto.dshmobile.collab

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Bundle
import androidx.core.content.ContextCompat
import com.labteto.dshmobile.connection.*
import com.labteto.dshmobile.core.wire.CentralCredential
import com.labteto.dshmobile.core.wire.CollaborationRelay
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/** One authenticated relay inbox per bound desktop, even when that desktop is offline. */
@Singleton
class CollaborationManager @Inject constructor(
    private val hosts: HostsStore,
    private val credentials: RelayCredentialStore,
    private val factory: HarnessClientFactory,
    private val notifications: CollaborationNotifications,
    @ApplicationContext private val context: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val visible = MutableStateFlow(false)
    private val serviceActive = MutableStateFlow(false)
    private val network = MutableStateFlow(0)
    private val jobs = mutableMapOf<String, Pair<HostConfig, Job>>()
    private val _status = MutableStateFlow<Map<String, String>>(emptyMap())
    val status: StateFlow<Map<String, String>> = _status.asStateFlow()
    private val _updates = MutableStateFlow<Map<String, String>>(emptyMap())
    val updates: StateFlow<Map<String, String>> = _updates.asStateFlow()
    private var started = false
    private var serviceRequested = false
    private val cursors = context.getSharedPreferences("collaboration_inbox", Context.MODE_PRIVATE)

    fun start() {
        if (started) return
        started = true
        (context.applicationContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            var count = 0
            override fun onActivityStarted(activity: Activity) { count++; visible.value = count > 0 }
            override fun onActivityStopped(activity: Activity) { count--; visible.value = count > 0 }
            override fun onActivityCreated(activity: Activity, state: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        runCatching { context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(value: Network) { network.update { it + 1 } }
            override fun onLost(value: Network) { network.update { it + 1 } }
        }) }
        scope.launch {
            var lastNetwork = network.value
            combine(hosts.hosts, hosts.settings, visible, serviceActive, network) { all, settings, foreground, service, epoch ->
                Triple(all.filter { it.centralRelay }, settings.collabBackground, Triple(foreground, service, epoch))
            }.collect { (paired, background, lifecycle) ->
                val (foreground, service, epoch) = lifecycle
                if (background && paired.isNotEmpty() && foreground && !serviceRequested && !service) {
                    serviceRequested = runCatching {
                        ContextCompat.startForegroundService(context, Intent(context, CollaborationService::class.java)); true
                    }.getOrElse { _status.update { it + ("background" to "后台服务未启动，请重新打开应用后重试") }; false }
                }
                if ((!background || paired.isEmpty()) && (serviceRequested || service)) {
                    context.stopService(Intent(context, CollaborationService::class.java)); serviceRequested = false
                }
                val desired = if (foreground || (background && service)) paired else emptyList()
                for ((id, current) in jobs.toMap()) if (epoch != lastNetwork || desired.none { it == current.first }) {
                    current.second.cancel(); jobs.remove(id)
                }
                lastNetwork = epoch
                _status.update { old -> old.filterKeys { key -> key == "background" || paired.any { it.id == key } } }
                for (host in desired) if (host.id !in jobs) jobs[host.id] = host to scope.launch { observe(host) }
            }
        }
    }

    fun serviceState(active: Boolean) { serviceActive.value = active; serviceRequested = active }

    private suspend fun client(host: HostConfig): Pair<CollaborationRelay, String> {
        val credential = CentralCredential.decode(checkNotNull(credentials.token(host.id)) { "电脑已解绑，请重新绑定" })
        check(credential.bindingToken.isNotBlank()) { "此绑定只有局域网通道，请先绑定中继" }
        return CollaborationRelay(factory.httpClient(host.relayFingerprint), host.baseUrl, credential) to credential.bindingId
    }

    suspend fun request(hostId: String, path: String, body: JsonObject? = null): JsonObject {
        val host = hosts.hosts.first().firstOrNull { it.id == hostId && it.centralRelay } ?: error("电脑已解绑")
        return client(host).first.request(path, body)
    }

    private suspend fun observe(host: HostConfig) {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            try {
                val (relay, bindingId) = client(host)
                _status.update { it + (host.id to "正在连接协作中继") }
                relay.changes().collect {
                    drain(host, bindingId, relay)
                    failures = 0
                    _status.update { it + (host.id to "协作消息已同步") }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                _status.update { it + (host.id to (e.message ?: "暂时离线，正在重连")) }
                delay((1000L shl failures.coerceAtMost(5)).coerceAtMost(30_000))
                failures++
            }
        }
    }

    private suspend fun drain(host: HostConfig, bindingId: String, relay: CollaborationRelay) {
        val key = host.id + ":" + bindingId
        var seen = cursors.getLong(key, 0)
        var highest = seen
        var offset = 0
        val pending = mutableMapOf<String, JsonObject>()
        do {
            val page = relay.request("inbox?offset=$offset")
            if (offset == 0) {
                val cursor = page.getValue("cursor").jsonPrimitive.long
                if (seen > cursor) { seen = 0; highest = 0 }
                _updates.update { it + (host.id to "$cursor:${page.getValue("unread")}") }
            }
            val rows = page.getValue("items").jsonArray.map { it.jsonObject }
            for (row in rows) {
                val id = row.getValue("id").jsonPrimitive.long
                highest = maxOf(highest, id)
                if (id > seen && !row.getValue("read").jsonPrimitive.boolean) pending.putIfAbsent(row.getValue("taskId").jsonPrimitive.content, row)
            }
            offset += rows.size
            if (rows.isEmpty() || rows.last().getValue("id").jsonPrimitive.long <= seen || page["hasMore"]?.jsonPrimitive?.boolean != true) break
            currentCoroutineContext().ensureActive()
        } while (true)
        currentCoroutineContext().ensureActive()
        // Never erase an undelivered notification just because Android denied the permission.
        if (pending.isNotEmpty() && !notifications.allowed()) return
        for ((taskId, _) in pending) notifications.message(host.id, taskId)
        withContext(Dispatchers.IO) { check(cursors.edit().putLong(key, highest).commit()) { "消息接收位置未保存" } }
    }
}
