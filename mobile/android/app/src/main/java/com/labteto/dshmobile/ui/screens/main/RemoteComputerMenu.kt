package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.connection.ConnectionPhase
import com.labteto.dshmobile.connection.HostConfig
import com.labteto.dshmobile.ui.components.*
import com.labteto.dshmobile.ui.rememberSessionStore
import com.labteto.dshmobile.ui.screens.connect.ConnectViewModel
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

internal val LocalRemoteComputer = staticCompositionLocalOf<String?> { null }

@Composable
internal fun RemoteSessionIcon() {
    val name = LocalRemoteComputer.current ?: return
    Icon(FeatherIcons.Globe, contentDescription = "远程会话 · $name", tint = DsTheme.colors.labelTertiary, modifier = Modifier.size(14.dp))
    Spacer(Modifier.width(DsSpacing.small))
}

@Composable
internal fun RemoteComputerMenu(onPair: () -> Unit, onClose: () -> Unit, viewModel: ConnectViewModel = hiltViewModel()) {
    val connection by rememberSessionStore().connectionState.collectAsStateWithLifecycle()
    val state by viewModel.state.collectAsStateWithLifecycle()
    val colors = DsTheme.colors
    var unbind by remember { mutableStateOf<HostConfig?>(null) }
    val current = connection.host
    val items = state.remembered.filter { it.centralRelay }.map { computer ->
        MenuItem(text = computer.name + if (computer.id == current?.id) " · 当前" else "", icon = FeatherIcons.Globe,
            onClick = { viewModel.connectTo(computer); onClose() })
    } + listOf(MenuItem(text = "扫码绑定电脑", onClick = onPair)) +
        if (current?.centralRelay == true) listOf(MenuItem(text = "解绑这台电脑", danger = true, onClick = { unbind = current })) else emptyList()
    DsMenu(anchor = {
        Row(Modifier.fillMaxWidth().padding(vertical = DsSpacing.medium), verticalAlignment = Alignment.CenterVertically) {
            Icon(FeatherIcons.Globe, contentDescription = "远程电脑", tint = colors.labelPrimary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(DsSpacing.small))
            Column(Modifier.weight(1f)) {
                Text(current?.name ?: "远程电脑", style = DsType.std14Strong, color = colors.labelPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (connection.phase == ConnectionPhase.CONNECTED) "已绑定 · 已连接" else "已绑定 · 正在重连", style = DsType.caption11, color = colors.labelSecondary)
            }
            Text("⌄", color = colors.labelTertiary)
        }
    }, items = items)
    if (state.pendingUnbinds > 0) Text("${state.pendingUnbinds} 个解绑请求待同步", style = DsType.caption11, color = colors.labelTertiary)
    state.bindingError?.let { Text(it, style = DsType.small13, color = colors.warnLabel) }
    unbind?.let { computer ->
        DsDialog(title = "解绑 ${computer.name}？", onDismiss = { unbind = null }) {
            Text("解绑后需要重新扫码。离线时会在恢复连接后同步。", style = DsType.std14, color = colors.labelSecondary)
            Row(horizontalArrangement = Arrangement.spacedBy(DsSpacing.small)) {
                DsButton(text = "解绑", onClick = { unbind = null; viewModel.forget(computer) }, variant = DsButtonVariant.Primary)
                DsButton(text = "取消", onClick = { unbind = null }, variant = DsButtonVariant.Ghost)
            }
        }
    }
}
