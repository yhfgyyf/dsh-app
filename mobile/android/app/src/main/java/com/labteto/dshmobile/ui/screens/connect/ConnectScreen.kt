package com.labteto.dshmobile.ui.screens.connect

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.connection.HostConfig
import com.labteto.dshmobile.ui.components.*
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

/** The only setup path is a QR binding issued by the user's desktop. */
@Composable
fun ConnectScreen(
    onOpenSettings: () -> Unit,
    onPair: (prefillUrl: String?) -> Unit,
    viewModel: ConnectViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val colors = DsTheme.colors
    val computers = state.remembered.filter { it.centralRelay }
    var unbind by remember { mutableStateOf<HostConfig?>(null) }
    Surface(modifier = Modifier.fillMaxSize(), color = colors.bgBase) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(DsSpacing.xlarge),
            verticalArrangement = Arrangement.spacedBy(DsSpacing.large)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("DSH Remote", style = DsType.large20, color = colors.labelPrimary)
                DsButton(text = "设置", onClick = onOpenSettings, variant = DsButtonVariant.Ghost)
            }
            Spacer(Modifier.height(36.dp))
            Icon(FeatherIcons.Globe, contentDescription = null, tint = colors.labelPrimary, modifier = Modifier.size(40.dp))
            Text(if (computers.isEmpty()) "连接你的电脑" else "你的电脑", style = DsType.large20, color = colors.labelPrimary)
            Text("扫码绑定，即可查看和继续电脑上的会话。", style = DsType.std14, color = colors.labelSecondary)
            DsButton(text = "扫码绑定电脑", onClick = { onPair(null) }, variant = DsButtonVariant.Primary, modifier = Modifier.fillMaxWidth())
            if (state.connecting) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = colors.labelPrimary)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (state.retrying) "正在重新连接…" else "正在连接…", modifier = Modifier.weight(1f), style = DsType.std14, color = colors.labelSecondary)
                    DsButton(text = "取消", onClick = viewModel::cancelConnect, variant = DsButtonVariant.Ghost)
                }
            }
            state.failure?.let { failure ->
                Text(if (failure == ConnectFailure.PairingRequired || failure == ConnectFailure.CertificateChanged) "绑定已失效，请重新扫码。"
                    else "暂时无法连接。请确认电脑正在运行，并检查网络。", style = DsType.std14, color = colors.warnLabel)
            }
            computers.forEach { computer ->
                DsCard(onClick = { viewModel.connectTo(computer) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(FeatherIcons.Globe, contentDescription = "远程电脑", tint = colors.labelSecondary, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(DsSpacing.small))
                        Column(Modifier.weight(1f)) {
                            Text(computer.name, style = DsType.std14Strong, color = colors.labelPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("已绑定 · 点击连接", style = DsType.small13, color = colors.labelSecondary)
                        }
                        DsButton(text = "解绑", onClick = { unbind = computer }, variant = DsButtonVariant.Ghost, size = DsButtonSize.Small)
                    }
                }
            }
            if (state.pendingUnbinds > 0) Text("${state.pendingUnbinds} 个解绑请求待同步；恢复连接后自动通知电脑。", style = DsType.small13, color = colors.labelTertiary)
            state.bindingError?.let { Text(it, style = DsType.std14, color = colors.warnLabel) }
        }
    }
    unbind?.let { computer ->
        DsDialog(title = "解绑 ${computer.name}？", onDismiss = { unbind = null }) {
            Text("解绑后需要重新扫码才能操作这台电脑。离线时会在恢复连接后同步。", style = DsType.std14, color = colors.labelSecondary)
            Row(horizontalArrangement = Arrangement.spacedBy(DsSpacing.small)) {
                DsButton(text = "解绑", onClick = { unbind = null; viewModel.forget(computer) }, variant = DsButtonVariant.Primary)
                DsButton(text = "取消", onClick = { unbind = null }, variant = DsButtonVariant.Ghost)
            }
        }
    }
}
