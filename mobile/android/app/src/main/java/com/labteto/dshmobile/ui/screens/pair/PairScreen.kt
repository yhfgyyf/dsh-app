package com.labteto.dshmobile.ui.screens.pair

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.labteto.dshmobile.ui.components.DsButton
import com.labteto.dshmobile.ui.components.DsButtonVariant
import com.labteto.dshmobile.ui.components.DsIconButton
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

@Composable
fun PairScreen(
    onClose: () -> Unit,
    prefillUrl: String? = null,
    viewModel: PairViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val colors = DsTheme.colors
    BackHandler(onBack = onClose)
    LaunchedEffect(state.paired) {
        if (state.paired != null) { viewModel.acknowledgePaired(); onClose() }
    }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(viewModel::onScanned) }
    val certificateInstaller = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        viewModel.continueAfterCaInstallation()
    }
    fun scan() = scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("扫描 DSH Desktop 的绑定二维码").setBeepEnabled(false).setOrientationLocked(false))
    var launched by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { if (!launched && !state.busy) { launched = true; scan() } }

    Surface(modifier = Modifier.fillMaxSize(), color = colors.bgBase) {
        Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(DsSpacing.xlarge), verticalArrangement = Arrangement.spacedBy(DsSpacing.large)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                DsIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", onClick = onClose)
                Text("绑定电脑", style = DsType.large20, color = colors.labelPrimary)
            }
            Spacer(Modifier.weight(1f))
            Text(state.computerName?.let { "连接 $it" } ?: "从手机继续电脑上的会话", style = DsType.large20, color = colors.labelPrimary)
            Text("在电脑的「设置 → 管理连接」中选择「扫码绑定手机」。", style = DsType.std14, color = colors.labelSecondary)
            if (state.busy) {
                CircularProgressIndicator(color = colors.labelPrimary)
                Text("正在绑定…", style = DsType.std14, color = colors.labelSecondary)
            }
            state.error?.let { Text(it, style = DsType.std14, color = colors.warnLabel) }
            state.caInstallation?.let { installation ->
                Text("需要信任中继证书", style = DsType.large20, color = colors.labelPrimary)
                Text("证书已与电脑二维码核对。请通过系统界面确认安装，完成后返回继续绑定。", style = DsType.std14, color = colors.labelSecondary)
                installation.fileName?.let { name ->
                    Text("已保存到 下载/DSH Remote/$name\n在系统设置中搜索「安装证书」，选择「CA 证书」并导入此文件。",
                        style = DsType.small13, color = colors.labelSecondary)
                }
                DsButton(text = if (installation.fileName != null) "打开证书设置" else "安装 CA 证书", onClick = {
                    try { certificateInstaller.launch(installation.intent()) }
                    catch (_: Exception) { viewModel.certificateSettingsUnavailable() }
                }, modifier = Modifier.fillMaxWidth())
                DsButton(text = "已安装，继续绑定", onClick = viewModel::continueAfterCaInstallation,
                    variant = DsButtonVariant.Outline, modifier = Modifier.fillMaxWidth())
            }
            DsButton(text = "扫描二维码", onClick = { scan() }, enabled = !state.busy,
                variant = DsButtonVariant.Primary, modifier = Modifier.fillMaxWidth())
            Text("同一 Wi-Fi 下可直接连接；已注册中继的电脑也支持异地连接。", style = DsType.small13, color = colors.labelTertiary)
            Spacer(Modifier.weight(1f))
        }
    }
}
