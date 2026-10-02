package com.labteto.dshmobile.collab

import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.connection.AppSettings
import com.labteto.dshmobile.connection.HostsStore
import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.theme.DshTheme
import com.labteto.dshmobile.ui.theme.ThemePreference
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private fun localTime(value: String) = runCatching { Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")) }.getOrDefault(value)

/** Uses the existing durable schedule service, bound to the desktop chosen at entry. */
@AndroidEntryPoint
class AutomationActivity : AppCompatActivity() {
    @Inject lateinit var sessions: SessionStore
    @Inject lateinit var hosts: HostsStore
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
        val connection by sessions.connectionState.collectAsStateWithLifecycle()
        val sessionId by sessions.currentSessionId.collectAsStateWithLifecycle()
        val hostKey = remember { intent.getStringExtra("hostKey") ?: sessions.activeHostKey }
        val api = if (connection.host != null) sessions.apiForHost(hostKey) else null
        var catalog by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
        var selectedJson by rememberSaveable { mutableStateOf<String?>(null) }
        val selected = remember(selectedJson) { selectedJson?.let { Json.parseToJsonElement(it).jsonObject } }
        fun select(value: JsonObject?) { selectedJson = value?.toString() }
        var history by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
        var nextBefore by remember { mutableStateOf("") }
        var historyNote by remember { mutableStateOf("") }
        var refresh by remember { mutableIntStateOf(0) }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        var creating by rememberSaveable { mutableStateOf(false) }
        var editing by rememberSaveable { mutableStateOf(false) }
        var deleting by remember { mutableStateOf(false) }
        var title by rememberSaveable { mutableStateOf("") }
        var prompt by rememberSaveable { mutableStateOf("") }
        var minutes by rememberSaveable { mutableStateOf("60") }
        var repeating by rememberSaveable { mutableStateOf(true) }
        var targetSession by rememberSaveable { mutableStateOf("") }
        val scope = rememberCoroutineScope()
        suspend fun rpc(method: String, args: JsonObject = JsonObject(emptyMap())): JsonElement {
            val client = api ?: error("请连接进入此页面时选择的电脑")
            return when (val result = client.call("schedule/$method", args, JsonElement.serializer())) {
                is RpcResult.Ok -> result.value
                is RpcResult.Err -> error(result.error.message)
            }
        }
        suspend fun loadHistory(task: JsonObject, before: String = "") {
            val result = rpc("history", buildJsonObject { put("request", buildJsonObject { put("id", task.text("id")); put("sessionId", task.text("sessionId")); put("limit", 20); if (before.isNotEmpty()) put("before", before) }) }).jsonObject
            if (result.text("code").isNotBlank()) error("任务历史暂不可用，请刷新")
            history = if (before.isEmpty()) result.objects("records") else history + result.objects("records")
            nextBefore = result.text("nextBefore")
            historyNote = if ((result["earlierRecordsUnavailable"] as? JsonPrimitive)?.booleanOrNull == true) "更早的执行记录可能已超出保存范围" else ""
        }
        fun action(block: suspend () -> Unit) { scope.launch {
            busy = true; error = null
            try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "操作失败，请刷新核对后重试" }
            finally { busy = false }
        } }
        LaunchedEffect(api, refresh) {
            if (api == null) return@LaunchedEffect
            busy = true; error = null
            try { catalog = (rpc("catalog") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty() }
            catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
            finally { busy = false }
        }
        LaunchedEffect(api, selected?.text("id")) {
            history = emptyList(); nextBefore = ""; historyNote = ""
            val task = selected ?: return@LaunchedEffect
            if (api != null) try { loadHistory(task) } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message }
        }
        fun back() { if (creating || editing) { creating = false; editing = false } else if (selected != null) select(null) else finish() }
        BackHandler { back() }
        Surface(modifier = Modifier.fillMaxSize()) {
            LazyColumn(modifier = Modifier.safeDrawingPadding().imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { back() }) { Text("返回") }
                    Text("自动化任务", modifier = Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall)
                    TextButton(enabled = api != null && !busy, onClick = { refresh++ }) { Text("刷新") }
                } }
                if (api == null) item { Text("连接原电脑后查看和管理自动化任务") }
                if (busy) item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
                error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
                val task = selected
                if (creating || editing) {
                    item { CollabTextField("任务名称（可选）", title, { title = it }, api, !busy, multiline = false, maxLength = 120) }
                    item { CollabTextField("任务内容", prompt, { prompt = it }, api, !busy, markdown = true, maxLength = 12000) }
                    if (creating) item {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(selected = repeating, onClick = { repeating = true }, label = { Text("按间隔重复") })
                            FilterChip(selected = !repeating, onClick = { repeating = false }, label = { Text("一次性任务") })
                        }
                        OutlinedTextField(value = minutes, onValueChange = { minutes = it.filter(Char::isDigit).take(8) }, label = { Text(if (repeating) "每隔多少分钟" else "多少分钟后执行") }, singleLine = true)
                        Text("执行结果会回到当前会话。电脑需要运行 DSH。", style = MaterialTheme.typography.bodySmall)
                    }
                    item { Button(enabled = api != null && !busy && prompt.isNotBlank() && (!creating || targetSession.isNotEmpty()), onClick = { action {
                        val name = title.trim().ifEmpty { prompt.lineSequence().firstOrNull { it.isNotBlank() }?.take(120).orEmpty() }
                        if (creating) {
                            val seconds = minutes.toLongOrNull()?.takeIf { it > 0 }?.times(60) ?: error("请输入大于 0 的分钟数")
                            rpc("create", buildJsonObject { put("sessionId", targetSession); put("request", buildJsonObject { put("title", name); put("prompt", prompt); put(if (repeating) "every_seconds" else "after_seconds", seconds) }) })
                        } else if (task != null) {
                            val expected = JsonObject(task.filterKeys { it !in setOf("sessionId", "status", "lastDelivery") })
                            val result = rpc("update", buildJsonObject { put("request", buildJsonObject { put("id", task.text("id")); put("sessionId", task.text("sessionId")); put("expected", expected); put("title", name); put("prompt", prompt) }) }).jsonObject
                            if (result["record"] == null) error("任务已更新或结束，请刷新后重试")
                            select(JsonObject(task + result.getValue("record").jsonObject))
                        }
                        creating = false; editing = false; refresh++
                    } }) { Text(if (creating) "创建任务" else "保存修改") } }
                } else if (task != null) {
                    item {
                        Text(task.text("title"), style = MaterialTheme.typography.titleLarge)
                        Text(if (task.text("status") == "active") "运行中 · 下次：" + localTime(task.text("scheduledAt")) else "已结束")
                        Text("类型：" + when (task.text("kind")) { "every" -> "每隔 " + task.text("everySeconds") + " 秒"; "daily" -> "每天"; "weekly" -> "每周"; "cron" -> "自定义时间"; else -> "一次性" })
                        MarkdownText(task.text("prompt"))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(enabled = api != null && !busy, onClick = { scope.launch { sessions.openSession(task.text("sessionId")); finish() } }) { Text("打开关联会话") }
                            if (task.text("status") == "active") TextButton(enabled = api != null && !busy, onClick = { title = task.text("title"); prompt = task.text("prompt"); editing = true }) { Text("编辑") }
                            TextButton(enabled = api != null && !busy, onClick = { deleting = true }) { Text("删除") }
                        }
                        Text("执行记录", style = MaterialTheme.typography.titleMedium)
                    }
                    if (history.isEmpty()) item { Text("暂无已保存的执行记录") }
                    items(history, key = { it.text("messageId") }) { record -> Card(modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                        Text(localTime(record.text("deliveredAt")))
                        MarkdownText(record.text("prompt", "此旧记录未保存任务内容"))
                    } } }
                    if (historyNote.isNotBlank()) item { Text(historyNote, style = MaterialTheme.typography.bodySmall) }
                    if (nextBefore.isNotBlank()) item { TextButton(enabled = !busy && api != null, onClick = { action { loadHistory(task, nextBefore) } }) { Text("更早记录") } }
                } else {
                    item { Button(enabled = api != null && sessionId != null && !busy, onClick = { creating = true; title = ""; prompt = ""; targetSession = sessionId.orEmpty() }) { Text("创建自动化任务") } }
                    if (catalog.isEmpty() && !busy) item { Text("暂无自动化任务。先打开一个会话，即可为它创建任务。") }
                    items(catalog, key = { it.text("id") }) { row -> OutlinedButton(onClick = { select(row) }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.fillMaxWidth()) {
                        Text(row.text("title"))
                        Text(if (row.text("status") == "active") "下次：" + localTime(row.text("scheduledAt")) else "已结束", style = MaterialTheme.typography.bodySmall)
                    } } }
                }
            }
        }
        if (deleting && selected != null) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("删除自动化任务？") }, text = { Text(selected!!.text("title") + "\n删除后不会再调度，已发送到会话中的消息仍保留。") },
            confirmButton = { TextButton(onClick = { val task = selected!!; deleting = false; action { rpc("delete", buildJsonObject { put("request", buildJsonObject { put("id", task.text("id")); put("sessionId", task.text("sessionId")) }) }); select(null); refresh++ } }) { Text("删除") } },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("取消") } })
    }
}
