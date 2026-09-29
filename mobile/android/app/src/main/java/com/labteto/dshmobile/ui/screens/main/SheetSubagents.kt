package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.session.AssistantMessageNode
import com.labteto.dshmobile.core.session.ChatNode
import com.labteto.dshmobile.core.session.ConversationSnapshot
import com.labteto.dshmobile.core.session.UserMessageNode
import com.labteto.dshmobile.core.wire.dto.SubagentListEntry
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.DsBottomSheet
import com.labteto.dshmobile.ui.components.DsButton
import com.labteto.dshmobile.ui.components.DsButtonSize
import com.labteto.dshmobile.ui.components.DsButtonVariant
import com.labteto.dshmobile.ui.components.DsPill
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.components.StateDot
import com.labteto.dshmobile.ui.components.StateDotState
import com.labteto.dshmobile.ui.components.UserBubble
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import kotlinx.coroutines.launch
import androidx.compose.ui.input.key.*

/**
 * The subagent catalog, with the selected child's transcript inline.
 *
 * Only continuable children accept messages; one-shot children and any child whose parent is
 * offline are read-only, which the sheet states rather than offering an input that would be
 * rejected.
 */
@Composable
internal fun SubagentsSheet(
    store: SessionStore,
    entries: List<SubagentListEntry>,
    conversation: ConversationSnapshot?,
    mode: String?,
    onDismiss: () -> Unit,
) {
    androidx.compose.runtime.DisposableEffect(store) { onDispose { store.closeSubagentTranscript() } }
    var childPanel by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val colors = DsTheme.colors
    val childId = conversation?.sessionId
    val connection by store.connectionState.collectAsStateWithLifecycle()
    androidx.compose.runtime.LaunchedEffect(connection.phase) {
        if (connection.phase == com.labteto.dshmobile.connection.ConnectionPhase.CONNECTED && childId != null) {
            store.openSubagentTranscript(childId)
        }
    }
    var draft by remember(childId) { mutableStateOf("") }
    var sending by remember(childId) { mutableStateOf(false) }
    var delivery by remember(childId) { mutableStateOf("queue") }
    val queueOperation = remember(childId) { mutableStateOf(false) }
    fun sendChild() {
        val text = draft
        val id = childId
        if (text.isBlank() || id == null || sending || queueOperation.value) return
        sending = true
        scope.launch {
            try { if (store.promptSubagent(id, text, delivery) && draft == text) draft = "" }
            finally { sending = false }
        }
    }
    val queues by store.sessionQueues.collectAsStateWithLifecycle()
    val childRunning = entries
        .firstOrNull { subagentId(it) == childId }
        ?.let { subagentRunning(it) } == true

    DsBottomSheet(
        title = stringResource(R.string.subagents_title),
        subtitle = entries.size.takeIf { it > 0 }?.toString(),
        onDismiss = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .heightIn(max = 460.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            if (entries.isEmpty()) {
                Text(
                    stringResource(R.string.subagents_empty),
                    style = DsType.caption11,
                    color = colors.labelTertiary,
                )
            }
            entries.forEach { entry ->
                SubagentRow(
                    entry = entry,
                    selected = subagentId(entry) == childId,
                    onClick = {
                        subagentId(entry)?.let { id -> scope.launch { store.openSubagentTranscript(id) } }
                    },
                )
            }

            conversation?.let { child ->
                if (child.nodes.isEmpty()) {
                    Text(
                        stringResource(R.string.common_loading),
                        style = DsType.caption11,
                        color = colors.labelTertiary,
                    )
                } else {
                    Column(Modifier.padding(vertical = DsSpacing.small)) {
                        androidx.compose.runtime.CompositionLocalProvider(
                            com.labteto.dshmobile.ui.media.LocalAttachmentScope provides (store.activeHostKey.orEmpty() to child.sessionId),
                            com.labteto.dshmobile.ui.components.LocalFileOpener provides { path ->
                                store.panels.get(ComposerKey(store.activeHostKey.orEmpty(), child.sessionId)).open(path); childPanel = true
                            },
                        ) {
                            val childContext = ChatNodeContext(child.nodes, child.running, null,
                                onOpenSubagent = {}, onBranchFrom = {}, onFeedback = { _, _ -> })
                            child.nodes.forEach { node -> ChatNodeItem(node, childContext) }
                        }
                    }
                }

                TextButton(onClick = { childPanel = true }) { Text(stringResource(R.string.panel_workspace)) }
                if (mode == "continuable") {
                    QueueDock(queues[child.sessionId].orEmpty(), store, sessionId = child.sessionId, blocked = sending, operationState = queueOperation)
                    Row {
                        TextButton(onClick = { delivery = "queue" }, enabled = !sending && !queueOperation.value) { Text((if (delivery == "queue") "✓ " else "") + stringResource(R.string.chat_queue_title)) }
                        TextButton(onClick = { delivery = "steer" }, enabled = !sending && !queueOperation.value) { Text((if (delivery == "steer") "✓ " else "") + stringResource(R.string.chat_queue_steer)) }
                    }
                }
                if (mode != "continuable") {
                    Text(
                        stringResource(R.string.subagents_readonly),
                        style = DsType.caption11,
                        color = colors.labelTertiary,
                    )
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextField(
                            value = draft,
                            onValueChange = { draft = it },
                            enabled = !sending && !queueOperation.value,
                            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Send),
                            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSend = { sendChild() }),
                            modifier = Modifier.weight(1f).onPreviewKeyEvent { event ->
                                if (event.key == Key.Enter && (event.isCtrlPressed || event.isMetaPressed)) {
                                    if (event.type == KeyEventType.KeyUp) sendChild()
                                    true
                                } else false
                            },
                            placeholder = {
                                Text(stringResource(R.string.subagents_message), style = DsType.std14)
                            },
                            colors = dialogTextFieldColors(),
                        )
                        Spacer(Modifier.width(DsSpacing.small))
                        if (childRunning) {
                            DsButton(
                                text = stringResource(R.string.subagents_interrupt),
                                onClick = {
                                    childId?.let { id -> scope.launch { store.interruptSubagent(id) } }
                                },
                                enabled = !sending && !queueOperation.value,
                                variant = DsButtonVariant.Danger,
                                size = DsButtonSize.Small,
                            )
                        }
                        run {
                            DsButton(
                                text = "",
                                icon = Icons.Filled.ArrowUpward,
                                onClick = { sendChild() },
                                variant = DsButtonVariant.Info,
                                enabled = draft.isNotBlank() && childId != null && !sending && !queueOperation.value,
                            )
                        }
                    }
                }
            }
        }
    }
    if (childPanel && childId != null) WorkspacePanels(store, store.panels.get(ComposerKey(store.activeHostKey.orEmpty(), childId))) { childPanel = false }
}

@Composable
private fun SubagentRow(entry: SubagentListEntry, selected: Boolean, onClick: () -> Unit) {
    val colors = DsTheme.colors
    val modeLabel = when (entry) {
        is SubagentListEntry.ChildOneShot -> stringResource(R.string.subagents_oneshot)
        is SubagentListEntry.ChildContinuable -> stringResource(R.string.subagents_continuable)
        else -> null
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = DsSpacing.xsmall),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StateDot(if (subagentRunning(entry)) StateDotState.Running else StateDotState.Idle)
        Spacer(Modifier.width(DsSpacing.small))
        Text(
            subagentLabel(entry) ?: subagentId(entry).orEmpty(),
            style = DsType.small13,
            color = colors.labelPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        modeLabel?.let { DsPill(text = it) }
        if (selected) {
            Spacer(Modifier.width(DsSpacing.xsmall))
            Icon(
                Icons.Filled.Check,
                contentDescription = null,
                tint = colors.accent,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun SubagentTranscriptRow(node: ChatNode) {
    when (node) {
        is UserMessageNode -> UserBubble(node.previewText)
        is AssistantMessageNode -> if (node.plainText.isNotBlank()) MarkdownText(node.plainText)
        else -> Unit
    }
}
