package com.labteto.dshmobile.ui.screens.pair

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.labteto.dshmobile.connection.ConnectionManager
import com.labteto.dshmobile.connection.HostConfig
import com.labteto.dshmobile.connection.HostsStore
import com.labteto.dshmobile.connection.RelayCredentialStore
import com.labteto.dshmobile.connection.RemoteBindings
import com.labteto.dshmobile.core.wire.CentralPairCode
import com.labteto.dshmobile.core.wire.pairDesktop
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import javax.inject.Inject

data class PairUiState(
    val busy: Boolean = false,
    val computerName: String? = null,
    val error: String? = null,
    val paired: HostConfig? = null,
)

@HiltViewModel
class PairViewModel @Inject constructor(
    private val hostsStore: HostsStore,
    private val credentials: RelayCredentialStore,
    private val bindings: RemoteBindings,
    private val connectionManager: ConnectionManager,
    private val okHttpClient: OkHttpClient,
) : ViewModel() {
    private val _state = MutableStateFlow(PairUiState())
    val state = _state.asStateFlow()

    fun onScanned(text: String) {
        if (_state.value.busy) return
        val qr = CentralPairCode.parse(text)
        if (qr == null || qr.version != 2) {
            _state.update { it.copy(error = "请扫描新版 DSH Desktop「管理连接」中的绑定二维码。") }
            return
        }
        if (qr.expiresAt <= System.currentTimeMillis()) {
            _state.update { it.copy(error = "二维码已过期，请在电脑上刷新后重试。") }
            return
        }
        _state.value = PairUiState(busy = true, computerName = qr.name)
        viewModelScope.launch {
            try {
                val name = listOfNotNull(Build.MANUFACTURER?.takeIf { Build.MODEL?.startsWith(it, ignoreCase = true) == false }, Build.MODEL)
                    .joinToString(" ").ifBlank { "Android" }.take(80)
                val credential = pairDesktop(okHttpClient, qr, name)
                val url = (credential.relay ?: credential.lanOrigins.first()).toHttpUrl()
                val config = HostConfig(id = "desktop-${qr.computerId}", name = qr.name, host = url.host, port = url.port,
                    useTls = url.isHttps, relayDeviceId = qr.computerId, centralRelay = true,
                    lastConnectedAt = System.currentTimeMillis())
                hostsStore.hosts.first().firstOrNull { it.id == config.id }?.let { bindings.unbind(it) }
                credentials.put(config.id, credential.encode())
                hostsStore.upsertHost(config)
                connectionManager.connect(config)
                _state.value = PairUiState(paired = config)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                _state.update { it.copy(busy = false, error = "未能完成绑定。请确认电脑仍在运行，手机与电脑处于同一 Wi-Fi，或电脑已注册可用中继，然后刷新二维码。") }
            }
        }
    }

    fun acknowledgePaired() { _state.value = PairUiState() }
}
