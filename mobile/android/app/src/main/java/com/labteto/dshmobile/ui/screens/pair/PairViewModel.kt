package com.labteto.dshmobile.ui.screens.pair

import android.os.Build
import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.labteto.dshmobile.connection.ConnectionManager
import com.labteto.dshmobile.connection.HostConfig
import com.labteto.dshmobile.connection.HostsStore
import com.labteto.dshmobile.connection.RelayCredentialStore
import com.labteto.dshmobile.connection.RemoteBindings
import com.labteto.dshmobile.core.wire.CentralPairCode
import com.labteto.dshmobile.core.wire.pairDesktop
import com.labteto.dshmobile.core.wire.RelayCaRequiredException
import com.labteto.dshmobile.core.wire.RelayCaPinMissingException
import com.labteto.dshmobile.core.wire.RelayCaVerificationException
import dagger.hilt.android.qualifiers.ApplicationContext
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
    val caInstallation: RelayCaInstallation? = null,
)

@HiltViewModel
class PairViewModel @Inject constructor(
    private val hostsStore: HostsStore,
    private val credentials: RelayCredentialStore,
    private val bindings: RemoteBindings,
    private val connectionManager: ConnectionManager,
    private val okHttpClient: OkHttpClient,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val _state = MutableStateFlow(PairUiState())
    val state = _state.asStateFlow()
    private var pendingCode: String? = null

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
        val previousInstallation = _state.value.caInstallation
        pendingCode = text
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
                pendingCode = null
                _state.value = PairUiState(paired = config)
            } catch (e: CancellationException) { throw e }
            catch (e: RelayCaRequiredException) {
                try {
                    val previous = previousInstallation?.takeIf { it.certificate.fingerprint == e.certificate.fingerprint }
                    val installation = previous ?: prepareCaInstallation(context, e.certificate)
                    _state.value = PairUiState(computerName = qr.name, caInstallation = installation,
                        error = if (previous != null) "尚未检测到证书信任，请在系统设置中完成安装后继续。" else null)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    _state.value = PairUiState(computerName = qr.name, error = "中继证书已核对，但无法保存到下载目录，请检查存储空间后重试。")
                }
            }
            catch (_: RelayCaPinMissingException) {
                _state.value = PairUiState(computerName = qr.name,
                    error = "手机尚未信任中继证书，且电脑二维码未包含 CA 指纹。请升级 DSH Desktop 后刷新二维码，或先手动安装中继 CA 证书。")
            }
            catch (_: RelayCaVerificationException) {
                _state.value = PairUiState(computerName = qr.name,
                    error = "无法核对中继证书，请确认电脑的中继配置并刷新二维码。证书未被安装。")
            }
            catch (e: Exception) {
                _state.update { it.copy(busy = false, error = "未能完成绑定。请确认电脑仍在运行，手机与电脑处于同一 Wi-Fi，或电脑已注册可用中继，然后刷新二维码。") }
            }
        }
    }

    fun continueAfterCaInstallation() { pendingCode?.let(::onScanned) }
    fun certificateSettingsUnavailable() {
        _state.update { it.copy(error = "无法打开证书设置，请在手机设置中搜索「安装证书」，选择 CA 证书并导入下载的文件。") }
    }
    fun acknowledgePaired() { _state.value = PairUiState() }
}
