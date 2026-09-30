package com.labteto.dshmobile.ui.screens.main

import androidx.compose.runtime.*
import kotlinx.coroutines.*

internal data class ComposerKey(val host: String, val sessionId: String)

/** Owned by SessionStore, so a gallery callback and an upload never follow UI navigation. */
internal class ComposerDraft(val key: ComposerKey) {
    var text by mutableStateOf("")
    var mode by mutableStateOf("queue")
    var preparing by mutableStateOf(false)
    var submitting by mutableStateOf(false)
    val attachments = mutableStateListOf<PendingAttachment>()

    fun restoreRejected(submittedText: String, submitted: List<PendingAttachment>) {
        if (text.isBlank()) text = submittedText
        attachments.addAll(0, submitted.filterNot { it in attachments })
    }
}

internal class ComposerRepository {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val drafts = mutableMapOf<ComposerKey, ComposerDraft>()
    fun get(key: ComposerKey): ComposerDraft = drafts.getOrPut(key) { ComposerDraft(key) }
    var imagePickTarget: Pair<ComposerDraft, com.labteto.dshmobile.core.wire.dto.ImageLimitsView>? = null
    var filePickTarget: ComposerDraft? = null
}
