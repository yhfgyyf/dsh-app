package com.labteto.dshmobile.collab

import android.content.Context
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.core.wire.DshApiClient
import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.screens.main.VoiceInput
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

internal fun JsonObject.text(key: String, fallback: String = ""): String = (this[key] as? JsonPrimitive)?.contentOrNull ?: fallback
internal fun JsonObject.objects(key: String): List<JsonObject> = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
internal suspend fun DshApiClient.collabValue(method: String, args: JsonObject = JsonObject(emptyMap())): JsonObject =
    when (val result = collaboration(method, args)) { is RpcResult.Ok -> result.value; is RpcResult.Err -> error(result.error.message) }

internal val LocalCollabVoiceOwner = compositionLocalOf { mutableStateOf<String?>(null) }

@Composable
internal fun CollabTextField(label: String, value: String, onChange: (String) -> Unit, api: DshApiClient?, enabled: Boolean = true, multiline: Boolean = true, markdown: Boolean = false, maxLength: Int = 49152) {
    val owner = LocalCollabVoiceOwner.current
    val id = remember { UUID.randomUUID().toString() }
    var status by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var preview by remember { mutableStateOf(false) }
    val currentValue by rememberUpdatedState(value)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, modifier = Modifier.weight(1f))
            if (markdown) TextButton(onClick = { preview = !preview }) { Text(if (preview) "编辑" else "预览") }
            VoiceInput(api = api, enabled = enabled && (owner.value == null || owner.value == id),
                onText = { onChange((currentValue + (if (currentValue.isBlank()) "" else "\n") + it).take(maxLength)) },
                onStatus = { status = it; if (it != null) owner.value = id else if (owner.value == id) owner.value = null },
                onError = { error = it }, finishLabel = "结束录音并填入文本")
        }
        if (preview) MarkdownText(value.ifBlank { "暂无内容" })
        else OutlinedTextField(value = value, onValueChange = { onChange(it.take(maxLength)) }, enabled = enabled,
            modifier = Modifier.fillMaxWidth(), singleLine = !multiline, minLines = if (multiline) 3 else 1)
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

/** A phone-owned draft is separate from the desktop editor's draft for the same task. */
@Composable
internal fun CollaborationComposer(
    hostId: String, task: JsonObject?, api: DshApiClient?, run: JsonObject?, onPublished: (String) -> Unit,
    onGeneratedFile: (JsonObject, String) -> Unit,
) {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("collaboration_drafts", Context.MODE_PRIVATE) }
    val draftKey = "$hostId:${task?.text("id") ?: "new"}"
    fun fresh() = buildJsonObject { put("operationId", UUID.randomUUID().toString()); put("kind", "message") }
    var draft by remember(draftKey) { mutableStateOf(runCatching { Json.parseToJsonElement(preferences.getString(draftKey, null) ?: "").jsonObject }.getOrElse { fresh() }) }
    var busy by remember(draftKey) { mutableStateOf(false) }
    var error by remember(draftKey) { mutableStateOf<String?>(null) }
    var extra by remember(draftKey) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val attachments = draft.objects("attachments")
    val generated = draft.objects("generatedFiles")
    fun change(update: JsonObject.() -> JsonObject) {
        val next = update(draft)
        draft = buildJsonObject { next.forEach { (key, value) -> put(key, value) }; put("operationId", UUID.randomUUID().toString()) }
        preferences.edit().putString(draftKey, draft.toString()).apply()
    }
    fun field(key: String, value: String) = change { JsonObject(this + (key to JsonPrimitive(value))) }
    fun importRun(value: JsonObject) {
        val submission = value["submission"] as? JsonObject
        change { val previous = this; buildJsonObject {
            previous.forEach { (key, item) -> put(key, item) }
            put("kind", if (value.text("mode") == "solve") "solution" else "message")
            put("body", submission?.text("body") ?: value.text("output"))
            put("verification", submission?.text("verification").orEmpty()); put("limitations", submission?.text("limitations").orEmpty())
            put("generatedFiles", submission?.get("files") ?: JsonArray(emptyList())); put("runId", value.text("id")); put("reportSnapshot", value.text("reportSnapshot"))
        } }
    }
    LaunchedEffect(run?.text("id"), run?.text("status")) {
        if (run?.text("status") == "completed" && run.text("publishMode") == "review" && run.text("submittedReplyId").isBlank() && draft.text("body").isBlank() && draft.text("lastSubmittedRun") != run.text("id")) importRun(run)
    }
    val selectFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty() && api != null) scope.launch {
            busy = true; error = null
            try {
                require(attachments.size + generated.size + uris.size <= 8) { "每次最多附带 8 个文件" }
                val selected = withContext(Dispatchers.IO) { uris.map { uri ->
                    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: "attachment"
                    val bytes = checkNotNull(context.contentResolver.openInputStream(uri)).use { input ->
                        val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= 8 * 1024 * 1024) { "附件“$name”超过 8 MiB，请在正文中提供下载链接" }; output.write(buffer, 0, count) }
                        output.toByteArray().also { require(it.isNotEmpty()) { "附件“$name”为空" } }
                    }
                    name.take(180) to Base64.getEncoder().encodeToString(bytes)
                } }
                for ((name, data) in selected) {
                    val file = api.collabValue("upload", buildJsonObject { put("operationId", UUID.randomUUID().toString()); put("name", name); put("data", data) })
                    change { JsonObject(this + ("attachments" to JsonArray(objects("attachments") + file))) }
                }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "上传失败，草稿已保留" }
            finally { busy = false }
        }
    }
    Card(modifier = Modifier.fillMaxWidth()) { Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(if (task == null) "发布任务" else "回复与提交", style = MaterialTheme.typography.titleMedium)
        if (task != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = draft.text("kind") != "solution", enabled = !busy, onClick = { field("kind", "message") }, label = { Text("回复消息") })
            FilterChip(selected = draft.text("kind") == "solution", enabled = !busy, onClick = { field("kind", "solution") }, label = { Text("提交方案") })
        }
        if (run != null && run.text("status") in listOf("completed", "stopped") && run.text("output").isNotBlank() && run.text("id") != draft.text("runId") && run["publication"] == null) {
            TextButton(enabled = !busy, onClick = { importRun(run) }) { Text("编辑 AI 结果与附件") }
        }
        CollabTextField(if (task == null) "问题详情" else "正文", draft.text("body"), { field("body", it) }, api, enabled = !busy, markdown = true)
        TextButton(onClick = { extra = !extra }) { Text(if (extra) "收起补充信息" else "补充信息（可选）") }
        if (extra) {
            if (task == null) {
                CollabTextField("标题（留空自动取正文第一行）", draft.text("title"), { field("title", it) }, api, !busy, multiline = false, maxLength = 200)
                CollabTextField("验收要求", draft.text("acceptance"), { field("acceptance", it) }, api, !busy, markdown = true, maxLength = 12000)
            } else if (draft.text("kind") == "solution") {
                CollabTextField("实际验证与结果", draft.text("verification"), { field("verification", it) }, api, !busy, markdown = true, maxLength = 16000)
                CollabTextField("限制与未验证部分", draft.text("limitations"), { field("limitations", it) }, api, !busy, markdown = true, maxLength = 8000)
            }
        }
        attachments.forEach { file -> Row(modifier = Modifier.fillMaxWidth()) {
            Text(file.text("name"), modifier = Modifier.weight(1f))
            TextButton(enabled = !busy, onClick = { change { JsonObject(this + ("attachments" to JsonArray(objects("attachments").filter { it.text("id") != file.text("id") }))) } }) { Text("移除") }
        } }
        generated.forEach { file -> Row(modifier = Modifier.fillMaxWidth()) {
            TextButton(enabled = api != null, modifier = Modifier.weight(1f), onClick = { onGeneratedFile(file, draft.text("runId")) }) { Text("查看附件：" + file.text("name")) }
            TextButton(enabled = !busy, onClick = { change { JsonObject(this + ("generatedFiles" to JsonArray(objects("generatedFiles").filter { it.text("id") != file.text("id") }))) } }) { Text("移除") }
        } }
        if (run != null && run.text("id") == draft.text("runId") && run.text("reportSnapshot") != draft.text("reportSnapshot")) TextButton(enabled = !busy, onClick = { field("reportSnapshot", run.text("reportSnapshot")) }) { Text("更新运行信息（保留正文和附件）") }
        TextButton(enabled = !busy && api != null && attachments.size + generated.size < 8, onClick = { selectFiles.launch(arrayOf("*/*")) }) { Text("添加图片或附件") }
        Text("支持 Markdown、代码和链接；每个附件最多 8 MiB，每次最多 8 个。语音只填入文本。", style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (api == null) Text("连接这台电脑后可发布和使用语音输入；草稿保存在手机。", style = MaterialTheme.typography.bodySmall)
        Button(enabled = api != null && !busy && draft.text("body").isNotBlank() && !(draft.text("kind") == "solution" && task?.text("status") in listOf("closed", "resolved")), onClick = {
            val client = api ?: return@Button
            scope.launch {
                busy = true; error = null
                try {
                    val result = client.collabValue(if (task == null) "create" else "reply", buildJsonObject {
                        put("operationId", draft.text("operationId")); put("attachments", JsonArray(attachments.map { it.getValue("id") }))
                        if (task == null) { put("title", draft.text("title")); put("description", draft.text("body")); put("acceptance", draft.text("acceptance")); put("tags", JsonArray(emptyList())) }
                        else {
                            put("taskId", task.text("id")); put("baseRevision", task.getValue("revision")); put("kind", draft.text("kind", "message")); put("body", draft.text("body"))
                            if (draft.text("runId").isNotEmpty()) { put("runId", draft.text("runId")); put("reportSnapshot", draft.text("reportSnapshot")); put("generatedFiles", JsonArray(generated.map { it.getValue("id") })) }
                            if (draft.text("kind") == "solution") put("solution", buildJsonObject { put("verification", draft.text("verification")); put("limitations", draft.text("limitations")) })
                        }
                    })
                    val submitted = draft.text("runId")
                    draft = buildJsonObject { fresh().forEach { (key, value) -> put(key, value) }; put("lastSubmittedRun", submitted) }
                    preferences.edit().putString(draftKey, draft.toString()).apply()
                    onPublished(if (task == null) result.text("id") else task.text("id"))
                } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message ?: "发布失败，草稿已保留" }
                finally { busy = false }
            }
        }) { Text(if (busy) "处理中…" else if (task == null) "发布任务" else if (draft.text("kind") == "solution") "发布方案" else "发送回复") }
    } }
}
