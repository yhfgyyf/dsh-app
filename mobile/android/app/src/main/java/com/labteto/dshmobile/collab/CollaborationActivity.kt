package com.labteto.dshmobile.collab

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.connection.AppSettings
import com.labteto.dshmobile.connection.HostsStore
import com.labteto.dshmobile.core.wire.collaborationTask
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.theme.DshTheme
import com.labteto.dshmobile.ui.theme.ThemePreference
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

private fun stateLabel(value: String) = when (value) { "open" -> "开放"; "review" -> "待验收"; "resolved" -> "已解决"; "closed" -> "已关闭"; else -> value }

/** Relay reads remain available offline. Editing and AI run through the selected paired desktop. */
@AndroidEntryPoint
class CollaborationActivity : AppCompatActivity() {
    @Inject lateinit var manager: CollaborationManager
    @Inject lateinit var hosts: HostsStore
    @Inject lateinit var sessions: SessionStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val settings by hosts.settings.collectAsStateWithLifecycle(initialValue = AppSettings())
            val voiceOwner = remember { mutableStateOf<String?>(null) }
            DshTheme(preference = runCatching { ThemePreference.valueOf(settings.themePreference.uppercase()) }.getOrDefault(ThemePreference.SYSTEM)) {
                CompositionLocalProvider(LocalCollabVoiceOwner provides voiceOwner) { Page() }
            }
        }
    }

    @Composable
    private fun Page() {
        val paired by hosts.hosts.collectAsStateWithLifecycle(initialValue = emptyList())
        val status by manager.status.collectAsStateWithLifecycle()
        val updates by manager.updates.collectAsStateWithLifecycle()
        val connection by sessions.connectionState.collectAsStateWithLifecycle()
        var hostId by rememberSaveable { mutableStateOf(intent.getStringExtra("hostId") ?: "") }
        var taskId by rememberSaveable { mutableStateOf(intent.getStringExtra("taskId") ?: "") }
        var view by rememberSaveable { mutableStateOf("all") }
        var creating by rememberSaveable { mutableStateOf(false) }
        var offset by rememberSaveable { mutableStateOf(0) }
        var refresh by remember { mutableIntStateOf(0) }
        // Changing the route invalidates its data in the same composition, before the effect runs.
        var data by remember(hostId, taskId, view, offset) { mutableStateOf<JsonObject?>(null) }
        var error by remember { mutableStateOf<String?>(null) }
        var busy by remember { mutableStateOf(false) }
        var actionBusy by remember { mutableStateOf(false) }
        var pendingFile by remember { mutableStateOf<ByteArray?>(null) }
        val api = if (connection.host?.id == hostId) sessions.apiForHost(sessions.activeHostKey) else null
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        var state by remember(hostId) { mutableStateOf<JsonObject?>(null) }
        var run by remember(hostId, taskId) { mutableStateOf<JsonObject?>(null) }
        var instruction by remember(hostId, taskId) { mutableStateOf("") }
        var instructionOpen by remember(hostId, taskId) { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val download = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
            val bytes = pendingFile; pendingFile = null
            if (uri != null && bytes != null) scope.launch {
                try { withContext(Dispatchers.IO) { checkNotNull(contentResolver.openOutputStream(uri)).use { it.write(bytes) } } }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = e.message ?: "文件保存失败" }
            }
        }
        fun saveAttachment(file: JsonObject, runId: String? = null) { scope.launch {
            try {
                val reply = if (runId != null) checkNotNull(api).collabValue("generated-file", buildJsonObject { put("runId", runId); put("fileId", file.text("id")) })
                    else if (api != null) api.collabValue("download", buildJsonObject { put("id", file.text("id")) })
                    else manager.request(hostId, "attachments/" + file.text("id"))
                val bytes = withContext(Dispatchers.Default) {
                    require(reply.text("data").length <= ((8 * 1024 * 1024 + 2) / 3) * 4)
                    val decoded = Base64.getDecoder().decode(reply.text("data"))
                    require(decoded.size.toLong() == (file["size"] as? JsonPrimitive)?.longOrNull && decoded.size <= 8 * 1024 * 1024)
                    val hash = MessageDigest.getInstance("SHA-256").digest(decoded).joinToString("") { "%02x".format(it) }
                    require(hash == file.text("sha256")) { "附件校验失败" }; decoded
                }
                pendingFile = bytes; download.launch(file.text("name"))
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "附件下载失败" }
        } }
        fun action(method: String, args: JsonObject) {
            val client = api ?: return
            scope.launch {
                actionBusy = true; error = null
                try { run = client.collabValue(method, args); refresh++ }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = e.message ?: "操作失败" }
                finally { actionBusy = false }
            }
        }
        LaunchedEffect(paired) {
            if (hostId.isEmpty()) hostId = connection.host?.id ?: paired.firstOrNull { it.centralRelay }?.id ?: ""
        }
        LaunchedEffect(api, hostId, taskId) {
            if (api == null) { state = null; return@LaunchedEffect }
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    try {
                        state = api.collabValue("state")
                        val current = state?.objects("runs")?.firstOrNull { it.text("taskId") == taskId }
                        if (current != null) {
                            val next = api.collabValue("run", buildJsonObject { put("runId", current.text("id")) })
                            if (run != null && (run?.text("status") != next.text("status") || run?.get("publication") != next["publication"])) refresh++
                            run = next
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (_: Exception) { state = null }
                    delay(if (taskId.isEmpty()) 15_000 else 3_000)
                }
            }
        }
        LaunchedEffect(api, hostId, taskId, view, offset, refresh, updates[hostId]) {
            if (hostId.isEmpty()) return@LaunchedEffect
            busy = true; error = null; data = null
            try {
                val value = if (api != null) api.collabValue(if (taskId.isNotEmpty()) "detail" else if (view == "inbox") "inbox" else "catalog",
                    buildJsonObject { put("offset", offset); if (taskId.isNotEmpty()) put("taskId", taskId) })
                    else manager.request(hostId, if (taskId.isNotEmpty()) "tasks/$taskId?offset=$offset" else if (view == "inbox") "inbox?offset=$offset" else "tasks?offset=$offset")
                data = value
                if (taskId.isNotEmpty() && value.collaborationTask(taskId) != null) {
                    val read = buildJsonObject { put("taskId", taskId); put("through", value.getValue("cursor")) }
                    if (api != null) api.collabValue("read", read) else manager.request(hostId, "inbox/read", read)
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "协作消息读取失败" }
            finally { busy = false }
        }
        fun back() { if (creating) creating = false else if (taskId.isNotEmpty()) { taskId = ""; offset = 0 } else finish() }
        BackHandler { back() }
        Surface(modifier = Modifier.fillMaxSize()) {
            LazyColumn(modifier = Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { back() }) { Text("返回") }
                    Text("协作空间", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { refresh++ }, enabled = !busy && hostId.isNotEmpty()) { Text("刷新") }
                } }
                if (taskId.isEmpty() && !creating) {
                    val choices = paired.filter { it.centralRelay || it.id == connection.host?.id }
                    if (choices.size > 1) items(choices, key = { it.id }) { host ->
                        OutlinedButton(onClick = { hostId = host.id; offset = 0 }, modifier = Modifier.fillMaxWidth()) { Text((if (host.id == hostId) "✓ " else "") + host.name) }
                    }
                    item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { view = "all"; offset = 0 }) { Text("全部任务") }
                        TextButton(onClick = { view = "inbox"; offset = 0 }) { Text("我的消息") }
                        TextButton(onClick = { creating = true }) { Text("发布任务") }
                    } }
                }
                if (api == null) item { Text(status[hostId] ?: if (hostId.isEmpty()) "请先绑定中继电脑，并在电脑上启用协作插件" else "从中继读取任务，电脑无需在线", style = MaterialTheme.typography.bodySmall) }
                if (busy && !creating) item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
                val payload = data
                val task = payload?.collaborationTask(taskId)
                if (creating) {
                    item { CollaborationComposer(hostId, null, api, null, onPublished = { taskId = it; creating = false; offset = 0; refresh++ }, onGeneratedFile = { file, id -> saveAttachment(file, id) }) }
                } else if (payload != null && task != null && taskId.isNotEmpty()) {
                    val peers = payload.objects("peers").associate { it.text("id") to it.text("nickname") }
                    item { SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(task.text("title"), style = MaterialTheme.typography.titleLarge)
                        Text("${stateLabel(task.text("status"))} · 版本 ${task.text("revision")} · ${peers[task.text("authorId")] ?: task.text("authorId")}")
                        MarkdownText(task.text("description"))
                        if (task.text("acceptance").isNotBlank()) MarkdownText("### 验收要求\n" + task.text("acceptance"))
                    } } }
                    items(payload.objects("attachments"), key = { "file:" + it.text("id") }) { file -> TextButton(onClick = { saveAttachment(file) }) { Text("下载附件：" + file.text("name")) } }
                    item {
                        val mode = (state?.get("settings") as? JsonObject)?.text("publishMode", "review") ?: "review"
                        val running = run?.text("status") in listOf("preparing", "running")
                        if (mode != "manual") Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(if (mode == "auto") "AI 完成后自动发布正文和附件" else "AI 生成后，由你审核和编辑再发布", style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                for ((value, label) in listOf("reply" to "一键 AI 回复", "solve" to "一键 AI 求解")) OutlinedButton(enabled = api != null && !actionBusy && !running && !(value == "solve" && task.text("status") in listOf("closed", "resolved")), onClick = {
                                    action("start", buildJsonObject { put("operationId", UUID.randomUUID().toString()); put("taskId", taskId); put("mode", value); put("instruction", instruction) })
                                }) { Text(label) }
                            }
                            TextButton(onClick = { instructionOpen = !instructionOpen }) { Text("给 AI 的补充要求（可选）") }
                            if (instructionOpen) CollabTextField("补充要求", instruction, { instruction = it }, api, !running && !actionBusy, maxLength = 12000)
                        }
                        run?.let { current ->
                            Text(when (current.text("status")) { "running", "preparing" -> "AI 正在处理"; "completed" -> "AI 已完成"; "stopped" -> "AI 已停止"; else -> "AI 执行失败" })
                            current.text("submissionError").takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                            val publication = current["publication"] as? JsonObject
                            if (publication?.text("status") == "published") Text("已自动发布正文和附件")
                            if (current.text("submittedReplyId").isNotBlank()) Text("已审核发布")
                            if (running || publication?.text("status") == "error") TextButton(enabled = api != null && !actionBusy, onClick = {
                                action(if (running) "cancel" else "publish-run", buildJsonObject { put("runId", current.text("id")) })
                            }) { Text(if (running) "停止本机任务" else "重试自动发布：" + publication?.text("error")) }
                        }
                    }
                    items(payload.objects("replies"), key = { "reply:" + it.text("id") }) { reply ->
                        Card(modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            val accepted = task.text("acceptedReplyId") == reply.text("id")
                            Text("${peers[reply.text("authorId")] ?: reply.text("authorId")} · ${if (reply.text("kind") == "solution") "解决方案" else "讨论"} · ${if (reply.text("actor") == "dsh") "DSH" else "用户"}${if (accepted) " · 已采纳" else ""}")
                            SelectionContainer { MarkdownText(reply.text("body")) }
                            (reply["solution"] as? JsonObject)?.let { solution ->
                                MarkdownText("### 验证\n" + solution.text("verification"))
                                if (solution.text("limitations").isNotBlank()) MarkdownText("### 限制\n" + solution.text("limitations"))
                                (solution["report"] as? JsonObject)?.let { Report(it) }
                            }
                            reply.objects("attachments").forEach { file -> TextButton(onClick = { saveAttachment(file) }) { Text("下载附件：" + file.text("name")) } }
                        } }
                    }
                    item { CollaborationComposer(hostId, task, api, run, onPublished = { refresh++ }, onGeneratedFile = { file, id -> saveAttachment(file, id) }) }
                } else if (payload != null && taskId.isNotEmpty()) {
                    item { Text("任务详情暂不可用，请刷新重试", color = MaterialTheme.colorScheme.error) }
                } else if (payload != null) {
                    val rows = payload.objects(if (view == "inbox") "items" else "tasks")
                    if (rows.isEmpty()) item { Text("暂无消息或任务") }
                    items(rows, key = { it.text("id") }) { row ->
                        OutlinedButton(onClick = { taskId = row.text(if (view == "inbox") "taskId" else "id"); offset = 0 }, modifier = Modifier.fillMaxWidth()) {
                            Text((if ((row["read"] as? JsonPrimitive)?.booleanOrNull == false) "● " else "") + row.text("title"))
                        }
                    }
                }
                if (!creating) item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(enabled = offset > 0 && !busy, onClick = { offset = (offset - 50).coerceAtLeast(0) }) { Text("上一页") }
                    TextButton(enabled = (data?.get("hasMore") as? JsonPrimitive)?.booleanOrNull == true && !busy, onClick = { offset += 50 }) { Text("下一页") }
                } }
            }
        }
    }

    @Composable
    private fun Report(report: JsonObject) {
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起运行信息与用量" else "运行信息与 Token 用量") }
        if (!expanded) return
        val usage = report["usage"] as? JsonObject ?: return
        val totals = usage["totals"] as? JsonObject ?: return
        val client = report["client"] as? JsonObject ?: return
        Text("DSH ${client.text("appVersion")} · ${client.text("platform")} ${client.text("arch")}")
        Text("输入 ${totals.text("uncachedInputTokens", "未知")} · 缓存读 ${totals.text("cacheReadTokens", "未知")} · 缓存写 ${totals.text("cacheWriteTokens", "未知")} · 输出 ${totals.text("outputTokens", "未知")} · 合计 ${totals.text("totalTokens", "未知")}")
        Text(usage.objects("routes").joinToString("\n") { "${it.text("provider")} / ${it.text("model")}" })
        Text("用量由客户端运行记录报告；缺失数据标为未知", style = MaterialTheme.typography.bodySmall)
    }
}
