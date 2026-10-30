package com.labteto.dshmobile.ui.screens.main

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.CallSplit
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.filled.ThumbUp
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.session.AssistantMessageNode
import com.labteto.dshmobile.core.session.ChatNode
import com.labteto.dshmobile.core.session.CommandNode
import com.labteto.dshmobile.core.session.CompactionNode
import com.labteto.dshmobile.core.session.DeveloperMessageNode
import com.labteto.dshmobile.core.session.GoalNode
import com.labteto.dshmobile.core.session.OtherNode
import com.labteto.dshmobile.core.session.PlanModeNode
import com.labteto.dshmobile.core.session.RetryNode
import com.labteto.dshmobile.core.session.SubagentNode
import com.labteto.dshmobile.core.session.TitleNode
import com.labteto.dshmobile.core.session.TodoNode
import com.labteto.dshmobile.core.session.ToolCallNode
import com.labteto.dshmobile.core.session.ToolResultNode
import com.labteto.dshmobile.core.session.TurnEndNode
import com.labteto.dshmobile.core.session.TurnErrorNode
import com.labteto.dshmobile.core.session.TurnStartNode
import com.labteto.dshmobile.core.session.UserMessageNode
import com.labteto.dshmobile.core.session.WorkflowNode
import com.labteto.dshmobile.ui.components.AttachmentImage
import com.labteto.dshmobile.ui.components.DisclosureRow
import com.labteto.dshmobile.ui.components.DisclosureState
import com.labteto.dshmobile.ui.components.DsPill
import com.labteto.dshmobile.ui.components.FeatherIcons
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.components.StateDot
import com.labteto.dshmobile.ui.components.StateDotState
import com.labteto.dshmobile.ui.components.ThinkingRow
import com.labteto.dshmobile.ui.components.ToolCard
import com.labteto.dshmobile.ui.components.UserBubble
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Everything one transcript row needs that is not on the node itself. */
internal data class ChatNodeContext(
    val nodes: List<ChatNode>,
    val running: Boolean,
    val cwd: String?,
    /** Host account home, used only to abbreviate a leftover home-rooted path as `~`. */
    val home: String? = null,
    val onOpenSubagent: (String) -> Unit,
    val onBranchFrom: (Long) -> Unit,
    val onFeedback: (Long, Boolean) -> Unit,
    val eventTimes: Map<Long, Long> = emptyMap(),
)

/**
 * One node of the conversation. The `when` is exhaustive over [ChatNode] on purpose: a harness that
 * grows a new event type still renders, because the fold produces an `OtherNode` rather than
 * dropping it, and this shows it rather than a gap in the transcript.
 */
@Composable
internal fun ChatNodeItem(node: ChatNode, context: ChatNodeContext) {
    val colors = DsTheme.colors
    when (node) {
        // Turn boundaries are structure, not content — the transcript shows the work, not the frame.
        is TurnStartNode -> Unit

        is UserMessageNode -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            node.blocks.filter { it.kind == "image" }.forEach { block ->
                parseImageRef(block)?.let { ref ->
                    AttachmentImage(
                        attachmentId = ref.attachmentId,
                        intrinsicWidth = ref.width,
                        intrinsicHeight = ref.height,
                        contentDescription = ref.name,
                    )
                }
            }
            // A file is a chip, not a preview: the host stores it verbatim and the model reads it
            // through its file tools, so there is nothing to render but what it is called.
            node.blocks.filter { it.kind == "file" }.forEach { block ->
                parseFileRef(block)?.let { ref ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        FileChip(name = ref.name, bytes = ref.bytes)
                    }
                }
            }
            val text = node.displayText()
            if (text.isNotBlank()) {
                // Injected context is not the reader's turn: it goes in a collapsed disclosure row
                // so the conversation still reads as a conversation. The predicate lives on the
                // node (core) because it is a wire fact about `source.kind`, not a UI choice.
                if (node.isInjectedContext) {
                    InjectedContextRow(node, text)
                } else {
                    UserBubble(text)
                }
            }
        }

        is AssistantMessageNode -> AssistantMessage(node, context)

        is ToolCallNode -> ToolCallRow(node, context)

        // Rendered inside the matching ToolCallNode's card; not a standalone row.
        is ToolResultNode -> Unit

        is TurnEndNode -> when (node.reasonKind) {
            "completed" -> Unit
            "aborted", "interrupted" -> DsPill(text = stringResource(R.string.chat_stopped), warn = true)
            "error" -> Row(verticalAlignment = Alignment.CenterVertically) {
                StateDot(StateDotState.Error, size = 8.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    stringResource(R.string.chat_error_turn) + node.reasonDetail?.let { " · $it" }.orEmpty(),
                    style = DsType.small13,
                    color = colors.error,
                )
            }
            "max-tokens" -> DsPill(text = stringResource(R.string.chat_max_tokens), warn = true)
            else -> Unit
        }

        is TodoNode -> parseTodos(node.todos)?.let { TodoDock(it) }

        is GoalNode -> parseGoal(node.data)?.let { GoalSummary(it) }

        is PlanModeNode -> DsPill(
            text = stringResource(if (node.active) R.string.plan_mode_on else R.string.plan_mode_off),
            warn = true,
        )

        is CompactionNode -> CompactionRow(node)

        is RetryNode -> {
            val delayMs = (node.data as? JsonObject)?.let { obj ->
                obj["delayMs"].asLong() ?: obj["ms"].asLong() ?: obj["providerRetryAfterMs"].asLong()
            }
            val label = if (delayMs != null && delayMs > 0) {
                stringResource(R.string.chat_retry_scheduled, (delayMs / 1000).toInt().coerceAtLeast(1))
            } else {
                // A retry with no stated delay used to read "Loading…", which says nothing about
                // what happened; four of them in a row before a failure is a story worth telling.
                stringResource(R.string.chat_retrying)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateDot(StateDotState.Warning, size = 8.dp)
                Spacer(Modifier.width(6.dp))
                Text(label, style = DsType.caption11, color = colors.labelTertiary)
            }
        }

        is TurnErrorNode -> Row(verticalAlignment = Alignment.CenterVertically) {
            StateDot(StateDotState.Error, size = 8.dp)
            Spacer(Modifier.width(6.dp))
            Text(
                stringResource(R.string.chat_error_turn) + " · " + node.message,
                style = DsType.small13,
                color = colors.error,
            )
            node.code?.let { Text(" · $it", style = DsType.caption11, color = colors.labelTertiary) }
        }

        is CommandNode -> CommandRow(node)

        is WorkflowNode -> WorkflowRow(node.data, context.onOpenSubagent)

        is DeveloperMessageNode -> ToolSetChangeRow(node)

        is TitleNode -> Text(node.title, style = DsType.caption11, color = colors.labelTertiary)
        is SubagentNode -> Text(
            stringResource(R.string.subagents_title),
            style = DsType.caption11,
            color = colors.labelTertiary,
        )
        // Unknown event types stay visible — that is the compatibility contract — but the
        // structural ones are not "unknown", they are bookkeeping, and printing `step/start` /
        // `step/end` between every tool call buried the actual work in noise.
        is OtherNode -> if (node.type !in STRUCTURAL_EVENT_TYPES) {
            if (node.type == "deliverables/presented") {
                val open = com.labteto.dshmobile.ui.components.LocalFileOpener.current
                ((node.data as? JsonObject)?.get("files") as? JsonArray)?.forEach { file ->
                    val obj = file as? JsonObject
                    val path = obj?.get("path").asString()
                    if (!path.isNullOrBlank()) androidx.compose.material3.OutlinedCard(onClick = { open(path) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(basename(path), style = DsType.std14)
                            Text(path, style = DsType.caption11)
                            obj?.get("description").asString()?.let { Text(it, style = DsType.small13) }
                        }
                    }
                }
            } else JsonDisclosure(when (node.type) {
                "system/message", "request/context" -> stringResource(R.string.system_prompt)
                "image/offload" -> stringResource(R.string.image_offload)
                else -> node.type
            }, node.data)
        }
    }
}

/** Event types that carry no user-facing content; they frame the transcript rather than fill it. */
internal val STRUCTURAL_EVENT_TYPES = setOf(
    "step/start",
    "step/end",
    "session/end-seed",
    "session/title-llm-request",
    "agent/inbox/spliced",
    "assistant/chunk",
    // A model attempt that settled without a message (harness 0.1.3): replay data, not content.
    "assistant/attempt",
)

/**
 * One stored file in a message: its display name and exact size, nothing more.
 *
 * There is no preview and no download — the harness keeps the bytes for the agent's file tools,
 * and the reference the log carries is a content digest rather than a path or a URL. The chip
 * says what was sent, which is all a transcript needs.
 */
@Composable
internal fun FileChip(name: String, bytes: Long, modifier: Modifier = Modifier) {
    val colors = DsTheme.colors
    Row(
        modifier = modifier
            .clip(DsShapes.block)
            .background(colors.bgModulePlatform)
            .border(1.dp, colors.borderL3, DsShapes.block)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            Icons.Outlined.Description,
            contentDescription = null,
            tint = colors.labelSecondary,
            modifier = Modifier.size(18.dp),
        )
        Column {
            Text(
                name,
                style = DsType.small13,
                color = colors.labelPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(fileSizeText(bytes), style = DsType.caption11, color = colors.labelTertiary)
        }
    }
}

// ---------------------------------------------------------------------------
// Assistant messages
// ---------------------------------------------------------------------------

@Composable
private fun AssistantMessage(node: AssistantMessageNode, context: ChatNodeContext) {
    val colors = DsTheme.colors
    val isLast = context.nodes.lastOrNull()?.seq == node.seq
    // A message the harness marked as a cancelled turn's prefix arrives before that turn's end,
    // so `running` is still true for a frame. Without this the last thing the user sees after
    // tapping stop is the answer apparently still being written.
    val streaming = context.running && isLast && !node.interrupted
    val reasoningExpanded = remember(node.seq) { mutableStateMapOf<Int, Boolean>() }
    var actionsVisible by remember(node.seq) { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = !streaming) { actionsVisible = !actionsVisible },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        node.blocks.forEachIndexed { index, block ->
            when (block.kind) {
                "text" -> MarkdownText(block.text.orEmpty())
                "reasoning" -> {
                    val expanded = reasoningExpanded[index] ?: false
                    ThinkingRow(
                        summary = block.text?.lineSequence()?.firstOrNull()
                            ?: stringResource(R.string.chat_thinking),
                        expanded = expanded,
                        onToggle = { reasoningExpanded[index] = !expanded },
                        streaming = streaming,
                    )
                    AnimatedVisibility(visible = expanded) {
                        MarkdownText(block.text.orEmpty())
                    }
                }
                // Tool calls arrive as their own nodes and render as cards; the inline block is a
                // duplicate reference, so it stays quiet here.
                "tool-call", "tool-result" -> Unit
                "image" -> parseImageRef(block)?.let { ref ->
                    AttachmentImage(
                        attachmentId = ref.attachmentId,
                        intrinsicWidth = ref.width,
                        intrinsicHeight = ref.height,
                        contentDescription = ref.name,
                    )
                }
                "file" -> parseFileRef(block)?.let { ref -> FileChip(name = ref.name, bytes = ref.bytes) }
                else -> block.text?.let {
                    Text(it, style = DsType.caption11, color = colors.labelTertiary)
                }
            }
        }
        if (node.interrupted) {
            DsPill(text = stringResource(R.string.chat_stopped), warn = true)
        }
        AnimatedVisibility(
            visible = actionsVisible && !streaming,
            enter = fadeIn(DsAnimations.fade),
            exit = fadeOut(DsAnimations.fade),
        ) {
            MessageActionsRow(node, context)
        }
    }
}

/**
 * Per-message actions, revealed on tap rather than always shown — a transcript with a row of icons
 * under every message reads as clutter, and these are all occasional.
 */
@Composable
private fun MessageActionsRow(node: AssistantMessageNode, context: ChatNodeContext) {
    val colors = DsTheme.colors
    val clipboard = LocalClipboardManager.current
    Row(
        modifier = Modifier.padding(top = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ActionIcon(Icons.Filled.ContentCopy, stringResource(R.string.chat_copy_message)) {
            clipboard.setText(AnnotatedString(node.plainText))
        }
        ActionIcon(Icons.AutoMirrored.Outlined.CallSplit, stringResource(R.string.chat_branch_message)) {
            context.onBranchFrom(node.seq)
        }
        ActionIcon(Icons.Filled.ThumbUp, stringResource(R.string.chat_feedback_up)) {
            context.onFeedback(node.seq, true)
        }
        ActionIcon(Icons.Filled.ThumbDown, stringResource(R.string.chat_feedback_down)) {
            context.onFeedback(node.seq, false)
        }
    }
}

@Composable
private fun ActionIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    Icon(
        icon,
        contentDescription = label,
        tint = DsTheme.colors.labelTertiary,
        modifier = Modifier
            .size(28.dp)
            .clickable(onClick = onClick)
            .padding(6.dp),
    )
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

@Composable
private fun ToolCallRow(node: ToolCallNode, context: ChatNodeContext) {
    val colors = DsTheme.colors
    val result = context.nodes
        .filterIsInstance<ToolResultNode>()
        .firstOrNull { it.callId == node.callId }

    val card = buildToolCardView(
        call = node,
        result = result,
        running = result == null && context.running,
        cwd = context.cwd,
        home = context.home,
    )
    // The row header is derived here rather than taken from the card: only this layer knows the
    // tool's name and the session's cwd, which is what turns an absolute path into `app\build.gradle.kts`.
    val row = toolRowModel(
        toolName = node.name,
        argumentsJson = node.arguments,
        cwd = context.cwd,
        // Derived from the call itself now: 0.1.2 sends no presenter title to prefer over it.
        viewTitle = null,
    )
    var expanded by remember(node.callId) { mutableStateOf(false) }
    // The leading slot carries the outcome: a red dot for a failed call, the tool glyph otherwise.
    val state = when {
        result?.isError == true -> DisclosureState.Error
        result == null && context.running -> DisclosureState.Running
        else -> DisclosureState.Idle
    }
    val startedAt = context.eventTimes[node.seq]
    val endedAt = result?.let { context.eventTimes[it.seq] }
    if (startedAt != null && endedAt != null) Text(
        com.labteto.dshmobile.ui.components.formatDurationMs((endedAt - startedAt).coerceAtLeast(0)),
        style = DsType.caption11, color = colors.labelCaption,
    )
    ToolCard(
        view = card,
        expanded = expanded,
        onToggle = { expanded = !expanded },
        titleOverride = row.title,
        summaryOverride = row.summary,
        iconOverride = row.variant.featherIcon(),
        state = state,
    )
    if (expanded) {
        result?.content?.let { JsonDisclosure(stringResource(R.string.chat_output_placeholder), it) }
        result?.meta?.let { JsonDisclosure(node.name, it) }
        PtcChildren(node.callId, context.nodes.filterIsInstance<OtherNode>())
    }
    if (result?.isError == true) {
        // The dot is colour-only, so the word stays — but without a second dot beside it.
        //
        // The call's own failure text, not a generic apology: "Something went wrong" told the
        // reader nothing they could act on, while the result body carries the command's stderr,
        // the refused path, or the tool's own message. The generic string is only the fallback
        // for a result that genuinely carries no prose.
        val failure = remember(result?.content) { toolFailureMessage(result?.content) }
        Text(
            failure ?: stringResource(R.string.common_error),
            style = DsType.caption11,
            color = colors.error,
            modifier = Modifier.padding(start = 26.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// Compaction / commands / workflow
// ---------------------------------------------------------------------------

@Composable
private fun CompactionRow(node: CompactionNode) {
    val summaryText = remember(node.seq) {
        runCatching {
            val array = (node.data as? JsonObject)?.get("summary") as? JsonArray
            array?.mapNotNull { (it as? JsonObject)?.get("text").asString() }?.joinToString("\n")
        }.getOrNull()
    }
    var expanded by remember(node.seq) { mutableStateOf(false) }
    DisclosureRow(
        title = stringResource(R.string.chat_compaction),
        summary = stringResource(R.string.chat_compaction_summary),
        icon = FeatherIcons.Archive,
        expanded = expanded,
        onToggle = { expanded = !expanded },
    ) {
        if (!summaryText.isNullOrBlank()) MarkdownText(summaryText)
    }
}

@Composable
private fun CommandRow(node: CommandNode) {
    val colors = DsTheme.colors
    val data = node.data as? JsonObject
    val name = data?.get("name").asString() ?: node.kind
    val text = data?.get("text").asString()
    var expanded by remember(node.seq) { mutableStateOf(false) }
    DisclosureRow(
        title = "/$name",
        summary = text,
        icon = FeatherIcons.Terminal,
        expanded = expanded,
        onToggle = { expanded = !expanded },
    ) {
        Text(
            node.data.toString(),
            style = DsType.caption11.copy(fontFamily = DsType.codeFont),
            color = colors.labelCaption,
            modifier = Modifier.padding(start = 28.dp, top = 2.dp),
        )
    }
}

@Composable
private fun WorkflowRow(
    data: kotlinx.serialization.json.JsonElement,
    onOpenMember: (String) -> Unit,
) {
    val colors = DsTheme.colors
    val obj = data as? JsonObject ?: return
    val name = obj["name"].asString()
    val status = obj["status"].asString() ?: obj["stopReason"].asString() ?: obj["outcome"].asString()
    val members = remember(data) { parseWorkflowMembers(data) }
    var expanded by remember(data) { mutableStateOf(false) }
    DisclosureRow(
        title = stringResource(R.string.workflow_title),
        summary = listOfNotNull(name, workflowStatusLabel(status)).joinToString(" · ").ifEmpty { null },
        icon = FeatherIcons.GitBranch,
        expanded = expanded,
        onToggle = { expanded = !expanded },
    ) {
        members.forEach { member ->
            val memberChildId = member.childId
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 28.dp, top = 2.dp)
                    .then(
                        if (memberChildId != null) {
                            Modifier.clickable { onOpenMember(memberChildId) }
                        } else {
                            Modifier
                        },
                    ),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StateDot(workflowMemberDot(member.status), size = 8.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    member.label ?: memberChildId.orEmpty(),
                    style = DsType.small13,
                    color = colors.labelSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                member.status?.let {
                    Text(
                        workflowStatusLabel(it) ?: it,
                        style = DsType.caption11,
                        color = colors.labelTertiary,
                    )
                }
            }
        }
        Spacer(Modifier.height(2.dp))
    }
}

/**
 * The readable failure text out of a `tool/result` body, or null when it carries none.
 *
 * `ToolResultNode.content` is the result body, `[ { type: "text", text: "Error: …" }, … ]`, in
 * both session formats: the fold unwraps the `tool-result` part that format v3 nested it in. The
 * walk still recurses through any `content` array it meets and takes the first `text` part at any
 * depth, so a tool that nests its own parts, or a container kind this build has not seen, still
 * yields its prose rather than the generic string.
 *
 * A bare string body is accepted too: some tools answer with one.
 */
internal fun toolFailureMessage(content: JsonElement?): String? {
    fun fromText(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }

    /** First prose part at or below [element], depth-first, or null. */
    fun walk(element: JsonElement?): String? = when (element) {
        null -> null
        is JsonPrimitive -> fromText(element.contentOrNull)
        is JsonArray -> element.firstNotNullOfOrNull { walk(it) }
        is JsonObject -> {
            val type = element["type"]?.jsonPrimitive?.contentOrNull
            // A container part (tool-result, or a nesting this build has not seen) is descended
            // into; a text part ends the search; anything else — an image, a structured blob — is
            // skipped rather than dumped at the reader.
            when {
                type == "text" || (type == null && element.containsKey("text")) ->
                    fromText(element["text"]?.jsonPrimitive?.contentOrNull)
                element.containsKey("content") -> walk(element["content"])
                // A flat error object: take its human-readable field.
                else -> fromText(
                    (element["message"] ?: element["error"])?.jsonPrimitive?.contentOrNull,
                )
            }
        }
        else -> null
    }

    return walk(content)
}

/**
 * Harness-injected context, folded into one disclosure row.
 *
 * Rendered as a collapse rather than a bubble because it is not the reader's turn: a system
 * prompt, an agent-instruction block or a skill invocation put on the user's side of the
 * conversation reads as though they had typed it. The row states the source kind so the reader can
 * tell which kind of context it is without expanding it.
 */
@Composable
private fun InjectedContextRow(node: UserMessageNode, text: String) {
    var expanded by remember(node.seq) { mutableStateOf(false) }
    DisclosureRow(
        title = stringResource(R.string.chat_context_title),
        summary = node.sourceKind ?: text.take(80),
        icon = FeatherIcons.Info,
        expanded = expanded,
        onToggle = { expanded = !expanded },
    ) {
        MarkdownText(text)
    }
}

/**
 * A change to the agent's tool set, harness 0.1.7's `developer/message`. It is context the model
 * sees rather than anything a person said, so it sits in the same collapsed row as other injected
 * context; the summary names the tools so the row is informative without opening it.
 */
@Composable
private fun ToolSetChangeRow(node: DeveloperMessageNode) {
    var expanded by remember(node.seq) { mutableStateOf(false) }
    val summary = (node.addedTools.map { "+$it" } + node.removedTools.map { "−$it" }).joinToString(", ")
    DisclosureRow(
        title = stringResource(R.string.chat_context_title),
        summary = stringResource(R.string.chat_context_tools) + " · " + summary,
        icon = FeatherIcons.Info,
        expanded = expanded,
        onToggle = { expanded = !expanded },
    ) {
        Text(summary, style = DsType.small13, color = DsTheme.colors.labelSecondary)
    }
}
