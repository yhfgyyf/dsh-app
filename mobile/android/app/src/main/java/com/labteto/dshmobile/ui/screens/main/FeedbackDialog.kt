package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.*
import com.labteto.dshmobile.data.SessionStore
import kotlinx.coroutines.*

@Composable
internal fun FeedbackDialog(store: SessionStore, key: ComposerKey, messageId: String, positive: Boolean, onDismiss: () -> Unit) {
    var note by remember(key, messageId) { mutableStateOf("") }
    var current by remember(key, messageId) { mutableStateOf<MessageFeedbackItem?>(null) }
    var busy by remember { mutableStateOf(true) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    suspend fun refresh() {
        val result = store.apiForHost(key.host)?.messageFeedbackList(key.sessionId)?.requireValue()
            ?: error(context.getString(R.string.common_offline))
        if (!result.ok) error(result.error?.code.orEmpty())
        current = result.value?.items?.firstOrNull { it.messageId == messageId }
        note = current?.note.orEmpty()
        loaded = true
    }
    fun submit(remove: Boolean) {
        if (busy || !loaded) return
        busy = true; error = null
        scope.launch {
            try {
                val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
                val failure = if (remove) {
                    val version = current?.version ?: return@launch
                    val result = api.messageFeedbackDelete(MessageFeedbackDeleteRequest(key.sessionId, messageId, version)).requireValue()
                    if (result.ok) null else result.error ?: MessageFeedbackFailure("unknown")
                } else {
                    val result = api.messageFeedbackPut(MessageFeedbackPutRequest(key.sessionId, messageId,
                        if (positive) "positive" else "negative", current?.version, note.takeIf { it.isNotBlank() })).requireValue()
                    if (result.ok) null else result.error ?: MessageFeedbackFailure("unknown")
                }
                if (failure != null) {
                    if (failure.code == "version-conflict") current = failure.current
                    error = failure.code
                } else onDismiss()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message }
            finally { busy = false }
        }
    }
    LaunchedEffect(key, messageId) {
        try { refresh() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = e.message }
        finally { busy = false }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(if (positive) R.string.chat_feedback_up else R.string.chat_feedback_down)) },
        text = { Column {
            OutlinedTextField(note, { note = it }, enabled = !busy, label = { Text(stringResource(R.string.feedback_note)) })
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (current != null) TextButton(onClick = { submit(true) }, enabled = !busy) { Text(stringResource(R.string.common_remove)) }
            if (!loaded && !busy) TextButton(onClick = {
                busy = true
                scope.launch { try { refresh(); error = null } catch (e: Exception) { error = e.message } finally { busy = false } }
            }) { Text(stringResource(R.string.common_retry)) }
        } },
        confirmButton = { TextButton(onClick = { submit(false) }, enabled = !busy && loaded) { Text(stringResource(R.string.feedback_send)) } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.common_cancel)) } })
}
