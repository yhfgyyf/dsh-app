package com.labteto.dshmobile.mockharness

import kotlinx.serialization.json.*
import java.util.concurrent.ConcurrentHashMap

/** Stateful, credential-free fixtures for the panel contracts, at harness 0.1.7. Never runs a shell. */
class PanelScenario(private val harness: MockHarness) {
    val archived = mutableSetOf("archived-demo")
    val feedback = ConcurrentHashMap<String, JsonObject>()
    val files = ConcurrentHashMap<String, ByteArray>().apply {
        put("README.md", "# Preview fixture\n\nTwo photos belong in one prompt.\n".toByteArray())
        put("index.html", "<h1>Isolated preview</h1><script>document.body.innerHTML='UNSAFE'</script>".toByteArray())
    }
    val terminals = ConcurrentHashMap<String, JsonObject>()
    /** Sessions with work still running, which `workspace/archiveSession` refuses without `stopActivity`. */
    val busy = mutableSetOf("busy-demo")
    /** The registry-global pin set, most recently pinned first. */
    val pinned = mutableListOf<String>()
    /** Jobs by id; `bash-1` runs until killed. */
    val jobs = ConcurrentHashMap<String, JsonObject>().apply {
        put("bash-1", Json.parseToJsonElement(
            """{"id":"bash-1","kind":"bash","label":"npm test","owner":"s","status":"running","startedAt":1000,"output":{"total":12,"earliest":0}}""",
        ).jsonObject)
    }
    val terminalInputs = mutableListOf<String>()
    private var revision = 0
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
    private fun ok(value: JsonElement) = buildJsonObject { put("ok", true); put("value", value) }
    private fun conflict(current: JsonObject?) = buildJsonObject {
        put("ok", false); putJsonObject("error") { put("code", "version-conflict"); put("current", current ?: JsonNull) }
    }
    init {
        harness.remote("permissionPresets", "catalog", emptySet()) {
            Json.parseToJsonElement("""{"options":[{"value":"default","name":"Default"},{"value":"auto","name":"Auto review"}]}""")
        }
        harness.requestRemote("workspace", "unarchiveSession", setOf("sessionId")) {
            archived.remove(it.string("sessionId"))
            buildJsonObject { put("archivedSessionIds", JsonArray(archived.map(::JsonPrimitive))) }
        }
        harness.requestRemote("messageFeedback", "list", setOf("sessionId")) { request ->
            ok(buildJsonObject { put("items", JsonArray(feedback.filterKeys { it.startsWith(request.string("sessionId") + ":") }.values.toList())) })
        }
        harness.requestRemote("messageFeedback", "put", setOf("sessionId", "messageId", "rating", "ifVersion")) { request ->
            synchronized(feedback) {
                val key = request.string("sessionId") + ":" + request.string("messageId")
                val old = feedback[key]
                if ((old?.get("version") ?: JsonNull) != request["ifVersion"]) conflict(old)
                else {
                    val item = buildJsonObject {
                        put("messageId", request.getValue("messageId")); put("rating", request.getValue("rating"))
                        request["note"]?.let { put("note", it) }; request["category"]?.let { put("category", it) }
                        put("version", "v${++revision}"); put("createdAt", old?.get("createdAt") ?: JsonPrimitive(1000)); put("updatedAt", 1000 + revision)
                    }
                    feedback[key] = item; ok(item)
                }
            }
        }
        harness.requestRemote("messageFeedback", "delete", setOf("sessionId", "messageId", "ifVersion")) { request ->
            synchronized(feedback) {
                val key = request.string("sessionId") + ":" + request.string("messageId")
                val old = feedback[key]
                if (old != null && old["version"] != request["ifVersion"]) conflict(old)
                else { feedback.remove(key); ok(buildJsonObject { put("absent", true) }) }
            }
        }
        harness.remote("workspaceFiles", "list", setOf("workspaceFileScopeId", "path")) {
            buildJsonObject {
                put("path", ""); put("truncated", false)
                put("entries", JsonArray(files.entries.sortedBy { it.key }.map { (name, bytes) ->
                    buildJsonObject { put("name", name); put("type", "file"); put("size", bytes.size) }
                }))
            }
        }
        for (method in listOf("stat", "read")) {
            val args = setOf("workspaceFileScopeId", "path") + if (method == "read") setOf("range") else emptySet()
            harness.remote("workspaceFiles", method, args) { request ->
                val path = request.string("path").removePrefix("./")
                val bytes = files[path] ?: throw MockHarness.RemoteFailure("workspace-file/not-found", "\"$path\" not found")
                buildJsonObject {
                    put("absolutePath", "/workspace/$path"); put("bytes", bytes.size); put("version", bytes.contentHashCode().toString())
                    if (method == "read") {
                        val range = request.getValue("range").jsonObject
                        val offset = range["offset"]?.jsonPrimitive?.int ?: 1
                        val limit = range["limit"]?.jsonPrimitive?.int ?: 500
                        val lines = bytes.toString(Charsets.UTF_8).lines()
                        val page = lines.drop(offset - 1).take(limit)
                        put("offset", offset); put("text", page.joinToString("\n")); put("lines", page.size); put("eof", offset - 1 + page.size >= lines.size)
                    }
                }
            }
        }
        // Harness 0.1.7: one binary read with `options` (a byte window, and a base file to resolve a
        // relative path against), answered as multipart. `readAll` and `readRelated` are gone.
        harness.binaryRemote("workspaceFiles", "readBytes", setOf("workspaceFileScopeId", "path", "options")) { request ->
            val options = request.getValue("options").jsonObject
            val base = options["baseFile"]?.jsonPrimitive?.content
            val requested = request.string("path").removePrefix("./")
            val path = if (base == null) requested else (base.substringBeforeLast('/', "") + "/" + requested).removePrefix("/")
            val bytes = files[path] ?: throw MockHarness.RemoteFailure("workspace-file/not-found", "\"$path\" not found")
            val range = options["range"] as? JsonObject
            val offset = range?.get("offset")?.jsonPrimitive?.int ?: 0
            val length = range?.get("length")?.jsonPrimitive?.int ?: bytes.size
            val end = (offset + length).coerceAtMost(bytes.size)
            val value = buildJsonObject {
                put("absolutePath", "/workspace/$path"); put("bytes", bytes.size); put("version", bytes.contentHashCode().toString())
                put("offset", offset); put("data", JsonNull); put("eof", end == bytes.size)
            }
            value to bytes.copyOfRange(offset.coerceAtMost(end), end)
        }
        harness.requestRemote("workspace", "archiveSession", setOf("sessionId"), optional = setOf("stopActivity")) { request ->
            val sessionId = request.string("sessionId")
            if (sessionId in busy && request["stopActivity"]?.jsonPrimitive?.booleanOrNull != true) {
                throw MockHarness.RemoteFailure(
                    "workspace/session-active",
                    "Session $sessionId has running work",
                    Json.parseToJsonElement("""{"sessionId":"$sessionId","activity":[{"kind":"turn"},{"kind":"job","items":[{"id":"bash-1","label":"npm test"}]}]}""").jsonObject,
                )
            }
            busy.remove(sessionId)
            archived.add(sessionId)
            buildJsonObject { put("archivedSessionIds", JsonArray(archived.map(::JsonPrimitive))) }
        }
        for (method in listOf("pinSession", "unpinSession")) {
            harness.requestRemote("workspace", method, setOf("sessionId")) { request ->
                val sessionId = request.string("sessionId")
                synchronized(pinned) {
                    pinned.remove(sessionId)
                    if (method == "pinSession") pinned.add(0, sessionId)
                    buildJsonObject { put("pinnedSessionIds", JsonArray(pinned.map(::JsonPrimitive))) }
                }
            }
        }
        harness.requestRemote("job", "kill", setOf("sessionId", "jobId")) { request ->
            val id = request.string("jobId")
            val job = jobs[id] ?: throw MockHarness.RemoteFailure("job/not-found", "unknown job $id")
            val finished = job.getValue("status").jsonPrimitive.content != "running"
            if (!finished) jobs[id] = JsonObject(job + mapOf("status" to JsonPrimitive("killed"), "finishedAt" to JsonPrimitive(2000)))
            buildJsonObject { put("outcome", if (finished) "already-finished" else "requested") }
        }
        harness.onStream("job/list") { args ->
            val request = args["request"] as? JsonObject
                ?: throw MockHarness.ArgumentsInvalid("typert gateway: job/list: args fields do not match the descriptor: missing \"request\"")
            request.string("sessionId")
            listOf(buildJsonObject { put("type", "rows"); put("jobs", JsonArray(jobs.values.toList())) })
        }
        harness.onStream("job/follow") { args ->
            val request = args["request"] as? JsonObject
                ?: throw MockHarness.ArgumentsInvalid("typert gateway: job/follow: args fields do not match the descriptor: missing \"request\"")
            val job = jobs[request.string("jobId")] ?: throw MockHarness.RemoteFailure("job/not-found", "unknown job")
            listOf(
                buildJsonObject { put("type", "opened"); put("job", job); put("from", 0) },
                Json.parseToJsonElement("""{"type":"output","chunks":[{"at":0,"text":"PASS  a.test\n","channel":"stdout"}],"next":12}"""),
            )
        }
        val shell = Json.parseToJsonElement("""{"path":"/mock/sh","args":[],"name":"Fixture shell"}""")
        harness.remote("terminal", "environment", setOf("agentId")) {
            Json.parseToJsonElement("""{"cwd":"/workspace","maxInputBytes":4096,"maxCols":240,"maxRows":100,"scrollback":1000}""")
        }
        harness.remote("terminal", "shells", setOf("agentId")) { JsonArray(listOf(shell)) }
        harness.remote("terminal", "list", setOf("sessionId")) { request ->
            JsonArray(terminals.filterKeys { it.startsWith(request.string("sessionId") + ":") }.values.toList())
        }
        harness.remote("terminal", "create", setOf("agentId", "request")) { args ->
            val request = args.getValue("request").jsonObject
            terminals.getOrPut(args.string("agentId") + ":" + request.string("id")) {
                buildJsonObject {
                    put("id", request.getValue("id")); put("title", "Fixture shell"); put("shell", shell)
                    put("cwd", "/workspace"); put("cols", request.getValue("cols")); put("rows", request.getValue("rows"))
                    put("state", "running"); put("exitCode", JsonNull)
                }
            }
        }
        for (method in listOf("write", "resize", "rename", "close")) {
            val expected = setOf("agentId", "id") + when (method) {
                "write" -> setOf("attachmentId", "data")
                "resize" -> setOf("attachmentId", "cols", "rows")
                "rename" -> setOf("title")
                else -> emptySet()
            }
            harness.remote("terminal", method, expected) { args ->
                val key = args.string("agentId") + ":" + args.string("id")
                val terminal = terminals[key] ?: error("terminal/not-found")
                if (method in setOf("write", "resize") && args["attachmentId"] != terminal["controllerId"]) error("terminal/control-unavailable")
                when (method) {
                    "write" -> terminalInputs.add(args.string("data"))
                    "resize" -> terminals[key] = JsonObject(terminal + args.filterKeys { it in setOf("cols", "rows") })
                    "rename" -> terminals[key] = JsonObject(terminal + ("title" to args.getValue("title")))
                    "close" -> terminals.remove(key)
                }
                JsonNull
            }
        }
        harness.onStream("terminal/follow") { args ->
            val key = args.string("agentId") + ":" + args.string("id")
            val terminal = terminals[key] ?: error("terminal/not-found")
            val info = JsonObject(terminal + ("controllerId" to args.getValue("attachmentId")))
            terminals[key] = info
            listOf(buildJsonObject { put("type", "snapshot"); put("sequence", 0); put("screen", "Fixture terminal\r\n$ "); put("info", info) })
        }
        // Harness 0.1.7 watches one named target per stream, and refuses the old workspace-wide form.
        harness.onStream("workspaceFiles/changes") { args ->
            if ("path" !in args) {
                throw MockHarness.ArgumentsInvalid(
                    "typert gateway: workspaceFiles/changes: args fields do not match the descriptor: missing \"path\"",
                )
            }
            listOf(buildJsonObject { put("kind", "ready") })
        }
    }
}
