package com.labteto.dshmobile.ui.screens.main

import android.graphics.BitmapFactory
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.media.sampleSizeFor
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswerItem
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionOption
import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.core.wire.dto.CommandSubmitAttachment
import com.labteto.dshmobile.core.wire.dto.ImageLimitsView
import com.labteto.dshmobile.data.CommandOutcome
import com.labteto.dshmobile.data.PromptOutcome
import com.labteto.dshmobile.data.QuestionOutcome
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.ApprovalPanel
import com.labteto.dshmobile.ui.components.ConnectionBanner
import com.labteto.dshmobile.ui.components.DsToastHost
import com.labteto.dshmobile.ui.components.PlanReviewPanel
import com.labteto.dshmobile.ui.components.planReviewOf
import com.labteto.dshmobile.ui.components.QuestionsPanel
import com.labteto.dshmobile.ui.components.rememberDsToast
import com.labteto.dshmobile.ui.rememberSessionStore
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsTheme
import androidx.compose.ui.res.stringResource
import com.labteto.dshmobile.R
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import com.labteto.dshmobile.core.session.readImageBounded
import com.labteto.dshmobile.core.wire.dto.ImageRejection

/**
 * The chat surface: chrome, transcript or trajectory, the persistent docks, and the composer.
 *
 * Everything below the tabs stays outside the tab swap on purpose — you can keep typing, and keep
 * answering an approval, while reading the trajectory, and the keyboard-attached surface never
 * animates out from under the cursor.
 */
@Composable
fun ChatScreen(
    onOpenDetails: () -> Unit,
    onOpenDrawer: () -> Unit,
    detailsOpen: Boolean,
) {
    val store = rememberSessionStore()
    val scope = rememberCoroutineScope()
    val colors = DsTheme.colors
    val context = LocalContext.current
    val toast = rememberDsToast()

    val conversation by store.currentConversation.collectAsStateWithLifecycle()
    val currentSessionId by store.currentSessionId.collectAsStateWithLifecycle()
    val sessions by store.sessions.collectAsStateWithLifecycle()
    val models by store.models.collectAsStateWithLifecycle()
    val skills by store.skills.collectAsStateWithLifecycle()
    val commands by store.commands.collectAsStateWithLifecycle()
    val commandsAvailable by store.commandsAvailable.collectAsStateWithLifecycle()
    val subagents by store.subagents.collectAsStateWithLifecycle()
    val subagentConversation by store.subagentConversation.collectAsStateWithLifecycle()
    val subagentMode by store.subagentMode.collectAsStateWithLifecycle()
    val connectionError by store.connectionError.collectAsStateWithLifecycle()
    val loadingOlder by store.loadingOlder.collectAsStateWithLifecycle()
    val loadOlderFailed by store.loadOlderFailed.collectAsStateWithLifecycle()
    val pendingApproval by store.pendingApproval.collectAsStateWithLifecycle()
    val pendingQuestions by store.pendingQuestions.collectAsStateWithLifecycle()
    val permissions by store.permissions.collectAsStateWithLifecycle()
    val pendingPermission by store.pendingPermission.collectAsStateWithLifecycle()
    val agentPresets by store.agentPresets.collectAsStateWithLifecycle()
    val sessionStats by store.sessionStats.collectAsStateWithLifecycle()
    val tokenUsage by store.tokenUsage.collectAsStateWithLifecycle()
    val contextBreakdown by store.contextBreakdown.collectAsStateWithLifecycle()
    val contextPressure by store.contextPressure.collectAsStateWithLifecycle()
    val imageLimits by store.imageLimits.collectAsStateWithLifecycle()

    val currentSession = sessions.firstOrNull { it.sessionId == currentSessionId }
    val title = currentSession?.title
        ?: currentSession?.cwd?.let { basename(it) }
        ?: currentSessionId.orEmpty()

    val connection by store.connectionState.collectAsStateWithLifecycle()
    val hostKey = connection.host?.let { "${it.baseUrl}|${it.id}" }.orEmpty()
    val composer = remember(hostKey, currentSessionId) {
        store.composers.get(ComposerKey(hostKey, currentSessionId.orEmpty()))
    }
    var draft by composer::text
    var mode by composer::mode
    var tab by rememberSaveable { mutableStateOf(ChatTab.Chat) }
    val attachments = composer.attachments
    var voiceStatus by remember(composer.key) { mutableStateOf<String?>(null) }
    val composerEnabled = currentSessionId != null && !composer.submitting &&
        !(connection.host?.centralRelay == true && connection.host?.remoteRole == "viewer")

    var panelKey by remember { mutableStateOf<ComposerKey?>(null) }
    var feedback by remember { mutableStateOf<Triple<ComposerKey, String, Boolean>?>(null) }
    var sheet by remember { mutableStateOf<ChatSheet?>(null) }

    // Hoisted above the tab swap so each view keeps its own scroll position across switches.
    val chatListState = rememberLazyListState()
    val trajectoryListState = rememberLazyListState()

    val commandFailed = stringResource(R.string.err_command_failed)
    val unknownCommand = stringResource(R.string.err_command_unknown)

    fun report(outcome: CommandOutcome) {
        when (outcome) {
            is CommandOutcome.Ok -> outcome.text?.takeIf { it.isNotBlank() }?.let { toast.second(it) }
            is CommandOutcome.Unknown -> toast.second(unknownCommand.format(outcome.line))
            is CommandOutcome.Failed -> toast.second(commandFailed.format(outcome.message))
        }
    }

    val answerRefused = stringResource(R.string.questions_answer_refused)
    val answerUnsent = stringResource(R.string.questions_answer_unsent)

    /**
     * What to tell the user about a question response, or null when the harness took it.
     *
     * A refusal is worth naming rather than swallowing: the host's wait stays open and the tool
     * call that opened it stays blocked, so a card that quietly did nothing would leave the session
     * stuck with no explanation.
     */
    fun refusalOf(outcome: QuestionOutcome): String? = when (outcome) {
        is QuestionOutcome.Accepted -> null
        is QuestionOutcome.Refused -> answerRefused.format(outcome.reason)
        is QuestionOutcome.Unsent -> answerUnsent
    }

    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        val selection = store.composers.imagePickTarget
        val target = selection?.first
        store.composers.imagePickTarget = null
        if (target != null && uris.isNotEmpty()) {
            target.preparing = true
            val limits = selection.second
            store.composers.scope.launch {
                val failures = mutableListOf<String>()
                try {
                    val existing = target.attachments.filterIsInstance<PendingAttachment.Image>()
                    val accepted = withContext(Dispatchers.IO) {
                        val selected = mutableListOf<PendingAttachment.Image>()
                        val admission = com.labteto.dshmobile.core.session.PhotoBatchAdmission(limits, existing.map { it.bytes })
                        for (uri in uris) {
                            try {
                                if (admission.full) {
                                    failures.add(imageRejectionText(context, ImageRejection.TOO_MANY, limits))
                                    continue
                                }
                                val resolver = context.contentResolver
                                val mediaType = resolver.getType(uri)
                                val bytes = (resolver.openInputStream(uri) ?: throw java.io.IOException("Unreadable image" )).use {
                                    readImageBounded(it, limits.maxImageBytes.coerceIn(0, Int.MAX_VALUE.toLong() - 1))
                                }
                                if (bytes == null) {
                                    failures.add(imageRejectionText(context, ImageRejection.TOO_LARGE, limits))
                                    continue
                                }
                                val pick = decodePick(bytes)
                                val rejection = admission.accept(
                                    mediaType.orEmpty(), pick.detectedMediaType, bytes.size, pick.width, pick.height,
                                )
                                if (rejection != null) {
                                    failures.add(imageRejectionText(context, rejection, limits))
                                    continue
                                }
                                selected.add(PendingAttachment.Image(
                                    mediaType = mediaType.orEmpty(), base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
                                    preview = pick.preview, bytes = bytes.size, width = pick.width, height = pick.height,
                                ))
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { failures.add(context.getString(R.string.err_attachment_failed)) }
                        }
                        selected
                    }
                    target.attachments.addAll(accepted)
                    if (failures.isNotEmpty()) toast.second(context.getString(
                        R.string.photos_skipped, failures.size, failures.distinct().joinToString("; "),
                    ))
                } finally { target.preparing = false }
            }
        }
    }

    /** Replace one pending file by identity; a chip that was removed meanwhile is left removed. */
    fun updateFile(target: ComposerDraft, id: String, transform: (PendingAttachment.File) -> PendingAttachment.File) {
        val attachments = target.attachments
        val index = attachments.indexOfFirst { it is PendingAttachment.File && it.id == id }
        if (index >= 0) attachments[index] = transform(attachments[index] as PendingAttachment.File)
    }

    /**
     * Stream one picked file to the host and settle its chip.
     *
     * The upload starts the moment the file is picked, as the web client's does, so by the time
     * the message is sent the receipt is usually already there; the chip shows progress until it
     * is, and the send affordance waits for it.
     */
    fun startUpload(file: PendingAttachment.File, target: ComposerDraft = composer) {
        updateFile(target, file.id) { it.copy(state = FileUploadState.Uploading(0)) }
        store.composers.scope.launch {
            val result = store.uploadFile(
                name = file.name,
                targetSessionId = target.key.sessionId,
                targetHost = target.key.host,
                size = file.size,
                open = { runCatching { context.contentResolver.openInputStream(file.uri) }.getOrNull() },
                onProgress = { sent -> updateFile(target, file.id) { it.copy(state = FileUploadState.Uploading(sent)) } },
            )
            updateFile(target, file.id) {
                when (result) {
                    is RpcResult.Ok -> it.copy(state = FileUploadState.Ready(result.value.receiptId, result.value.file))
                    is RpcResult.Err -> it.copy(state = FileUploadState.Failed(result.error.message))
                }
            }
        }
    }

    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val target = store.composers.filePickTarget
        store.composers.filePickTarget = null
        if (uri == null || target == null) return@rememberLauncherForActivityResult
        val (name, size) = describeDocument(context.contentResolver, uri)
        if (name == null) {
            toast.second(context.getString(R.string.err_file_read_failed))
            return@rememberLauncherForActivityResult
        }
        val file = PendingAttachment.File(
            id = UUID.randomUUID().toString(),
            uri = uri,
            name = name,
            size = size,
            state = FileUploadState.Uploading(0),
        )
        target.attachments.add(file)
        startUpload(file, target)
    }

    fun send(text: String) {
        if (composer.preparing || composer.submitting) { draft = text; return }
        val delivery = mode
        val targetId = composer.key.sessionId
        val targetHost = composer.key.host
        val pending = attachments.toList()
        if (text.isBlank() && pending.isEmpty()) return
        val images = pending.filterIsInstance<PendingAttachment.Image>()
        val files = pending.filterIsInstance<PendingAttachment.File>()
        // A file without a receipt cannot be cited. The send affordance already waits for the
        // chips, but a keyboard send lands here too.
        if (files.any { it.state !is FileUploadState.Ready }) {
            draft = text
            toast.second(
                context.getString(
                    if (files.any { it.state is FileUploadState.Failed }) R.string.chat_attachment_upload_failed
                    else R.string.chat_attachment_still_uploading,
                ),
            )
            return
        }
        val receipts = files.mapNotNull { it.receiptId }
        // A slash line that names a registered command is not a message: `session/prompt` would
        // hand it to the model verbatim, so it has to be recognised here and written through the
        // command gateway. A miss falls through to the prompt path — that is how skills work.
        when (val submission = adjudicate(text, commands, pending.size, store.commandAttachmentsSupported)) {
            is Submission.Refused -> {
                // Nothing is sent and nothing is dropped. The composer clears the draft on its way
                // here, so put it back, and leave the attachments alone — a refusal the user cannot
                // act on without re-picking every one is not much of a refusal.
                draft = text
                val message = when (submission.reason) {
                    RefusalReason.COMMAND_TAKES_NO_ATTACHMENTS -> R.string.err_command_no_images
                    RefusalReason.HOST_TOO_OLD -> R.string.err_command_images_host
                }
                toast.second(context.getString(message, submission.command))
            }

            is Submission.Command -> {
                composer.submitting = true
                attachments.clear()
                val submitted = images.map { it.encoded().asSubmit() } +
                    receipts.map { CommandSubmitAttachment.File(it) }
                store.composers.scope.launch {
                    try {
                    val outcome = store.runCommand(submission.line, submitted, targetId, targetHost)
                    // An attachment-carrying command consumes its attachments only on success, as
                    // the harness client does: an error result is something to correct, and
                    // correcting it should not start with picking every file again. A plain
                    // command that fails keeps today's behaviour, because its whole submission was
                    // the line. The restore only lands in a composer nobody has touched meanwhile —
                    // the call is in flight while the user can still type and pick.
                    if (outcome is CommandOutcome.Failed) {
                        composer.restoreRejected(text, pending)
                    }
                    report(outcome)
                    } catch (e: kotlinx.coroutines.CancellationException) { composer.restoreRejected(text, pending); throw e }
                    catch (e: Exception) { composer.restoreRejected(text, pending); toast.second(e.message ?: context.getString(R.string.panel_failed)) }
                    finally { composer.submitting = false }
                }
            }

            is Submission.Prompt -> {
                composer.submitting = true
                attachments.clear()
                store.composers.scope.launch {
                    try {
                    // One call, whatever the count. The host admits a prompt's images as a single
                    // batch, and that batch is the only thing its per-message count and total-size
                    // bounds are measured against — sending one image per call made a single
                    // message into several and put both limits permanently out of reach. Files
                    // ride the same call as receipts; a receipt the host refuses stays staged,
                    // so restoring the chips is enough to try again.
                    val outcome = if (pending.isEmpty()) {
                        store.prompt(text, delivery, targetId, targetHost)
                    } else {
                        store.promptWithAttachments(text, delivery, images.map { it.encoded() }, receipts, targetId, targetHost)
                    }
                    if (outcome !is PromptOutcome.Ok) {
                        composer.restoreRejected(text, pending)
                        toast.second(
                            if (outcome is PromptOutcome.Rejected) imageRejectionText(context, outcome.rejection, imageLimits, outcome.reason)
                            else (outcome as PromptOutcome.Failed).message,
                        )
                    }
                    } catch (e: kotlinx.coroutines.CancellationException) { composer.restoreRejected(text, pending); throw e }
                    catch (e: Exception) { composer.restoreRejected(text, pending); toast.second(e.message ?: context.getString(R.string.panel_failed)) }
                    finally { composer.submitting = false }
                }
            }
        }
    }

    androidx.compose.runtime.CompositionLocalProvider(
        com.labteto.dshmobile.ui.media.LocalAttachmentScope provides (composer.key.host to composer.key.sessionId),
        com.labteto.dshmobile.ui.components.LocalFileOpener provides { path: String ->
        store.panels.get(composer.key).open(path); panelKey = composer.key
    }) {
    Surface(modifier = Modifier.fillMaxSize(), color = colors.bgBase) {
        // The activity draws edge to edge, so every top-level surface has to consume the insets
        // itself or the chrome ends up underneath the status bar. safeDrawing covers the status
        // bar, the gesture area and the keyboard in one modifier.
        Column(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
            ChatTopBar(
                title = title,
                running = conversation?.running == true,
                models = models,
                agentPresetLabel = currentSession?.agentPreset?.takeIf { agentPresets?.modeSelectionEnabled != false }?.let { agentPresetLabel(it, agentPresets) },
                subagentCount = subagents.size,
                detailsOpen = detailsOpen,
                tab = tab,
                onOpenDrawer = onOpenDrawer,
                onOpenModels = { sheet = ChatSheet.Models },
                onOpenPresets = {
                    scope.launch { store.refreshAgentPresets() }
                    sheet = ChatSheet.Presets
                },
                onOpenSubagents = { sheet = ChatSheet.Subagents },
                onOpenDetails = onOpenDetails,
                onTabChange = { tab = it },
            )

            connectionError?.let {
                androidx.compose.material3.TextButton(onClick = { store.retryConnection() }) { ConnectionBanner(it) }
            }
            androidx.compose.material3.TextButton(onClick = { panelKey = composer.key }, enabled = currentSessionId != null) {
                androidx.compose.material3.Text(stringResource(R.string.panel_workspace))
            }
            if (conversation?.gap == true) {
                ConnectionBanner(stringResource(R.string.common_reconnecting))
            }

            val nodeContext = ChatNodeContext(
                nodes = conversation?.nodes ?: emptyList(),
                eventTimes = conversation?.journal?.associate { it.seq to it.time }.orEmpty(),
                running = conversation?.running == true,
                cwd = currentSession?.cwd,
                onOpenSubagent = { childId ->
                    scope.launch { store.openSubagentTranscript(childId) }
                    sheet = ChatSheet.Subagents
                },
                onBranchFrom = { seq -> scope.launch { currentSessionId?.let { store.forkSession(it, seq) } } },
                onFeedback = { seq, positive ->
                    conversation?.nodes?.filterIsInstance<com.labteto.dshmobile.core.session.AssistantMessageNode>()
                        ?.firstOrNull { it.seq == seq }?.messageId?.let { feedback = Triple(composer.key, it, positive) }
                },
            )

            AnimatedContent(
                targetState = tab,
                transitionSpec = {
                    val forward = targetState.ordinal > initialState.ordinal
                    (
                        slideInHorizontally { width -> if (forward) width / 6 else -width / 6 } +
                            fadeIn(DsAnimations.fade)
                        )
                        .togetherWith(fadeOut(DsAnimations.fade)) using SizeTransform(clip = false)
                },
                modifier = Modifier.weight(1f),
                label = "chatTab",
            ) { current ->
                when (current) {
                    ChatTab.Chat -> ChatTranscript(
                        conversation = conversation,
                        loading = conversation == null && currentSessionId != null,
                        loadingOlder = loadingOlder,
                        loadOlderFailed = loadOlderFailed,
                        context = nodeContext,
                        listState = chatListState,
                        onLoadOlder = { scope.launch { store.loadOlder() } },
                    )
                    ChatTab.Trajectory -> TrajectoryTab(
                        conversation = conversation,
                        stats = sessionStats,
                        usage = tokenUsage,
                        cwd = currentSession?.cwd,
                        listState = trajectoryListState,
                    )
                }
            }

            conversation?.let { conv ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    parseTodos(conv.projections["todos"])?.let { TodoDock(it) }
                    parseGoal(conv.projections["goal"])?.let { GoalBar(it, store) }
                    QueueDock(conv.queue, store)
                }
            }

            // Server-initiated requests take over the bottom of the screen: they block the turn,
            // so burying them behind a scroll would strand the session.
            val approval = pendingApproval
            if (approval != null && approval.sessionId == currentSessionId) {
                // A refusal is said out loud here rather than swallowed, for the reason [refusalOf]
                // gives: the host's wait — and the tool call behind it — stays open, and a panel
                // that reported nothing would read as two buttons that do nothing.
                fun decide(allow: Boolean) = scope.launch {
                    refusalOf(store.respondApproval(approval.sessionId, approval.approvalId, allow))
                        ?.let { toast.second(it) }
                }
                ApprovalPanel(
                    toolName = approval.toolName,
                    reason = approval.reason,
                    onAllow = { decide(true) },
                    onReject = { decide(false) },
                )
            }
            val questions = pendingQuestions
            if (questions != null && questions.sessionId == currentSessionId) {
                var planBusy by remember(questions.rpcId) { mutableStateOf(false) }
                // A plan review rides the question channel but is a different decision, so it gets
                // the card built for it. The narrowing decides which — and hands back anything the
                // card could not answer in full, because the card answers one question and the host
                // refuses an answer batch shorter than the request it resolves.
                val review = remember(questions.rpcId) { planReviewOf(questions.items) }
                if (review != null) {
                    fun settle(block: suspend () -> QuestionOutcome) {
                        planBusy = true
                        scope.launch {
                            refusalOf(block())?.let {
                                planBusy = false
                                toast.second(it)
                            }
                        }
                    }
                    fun decide(option: AskUserQuestionOption) = settle {
                        store.answerQuestions(
                            questions.sessionId,
                            AskUserQuestionAnswer(
                                listOf(AskUserQuestionAnswerItem(review.id, listOf(option.label))),
                            ),
                        )
                    }
                    PlanReviewPanel(
                        review = review,
                        busy = planBusy,
                        onApprove = { decide(review.approve) },
                        onDecline = { review.decline?.let { decide(it) } },
                        // Wanting to talk it over first is not one of the options the asker stated,
                        // so it ends the request rather than answering it with the refusal.
                        onDiscuss = {
                            draft = ""
                            settle { store.dismissQuestions(questions.sessionId) }
                        },
                    )
                } else {
                    QuestionsPanel(
                        requestKey = questions.rpcId,
                        questions = questions.items,
                        onSubmit = { answer ->
                            refusalOf(store.answerQuestions(questions.sessionId, answer))
                        },
                        onDismiss = { refusalOf(store.dismissQuestions(questions.sessionId)) },
                    )
                }
            }

            if (connection.host?.centralRelay == true && connection.host?.remoteRole == "viewer") {
                androidx.compose.material3.Text("此手机仅有查看权限。", modifier = Modifier.padding(12.dp))
            }
            Composer(
                draft = draft,
                onDraftChange = { draft = it },
                attachments = attachments,
                onRemoveAttachment = { index -> attachments.removeAt(index) },
                onRetryAttachment = { index ->
                    (attachments.getOrNull(index) as? PendingAttachment.File)?.let { startUpload(it) }
                },
                permissions = permissions,
                pendingPermission = pendingPermission,
                onPermissionPick = { value -> scope.launch { report(store.setPermissionPreset(value)) } },
                contextBreakdown = contextBreakdown,
                contextPressure = contextPressure,
                running = conversation?.running == true,
                enabled = composerEnabled && voiceStatus == null,
                preparing = composer.preparing,
                voiceStatus = voiceStatus,
                voiceInput = { key(composer.key) {
                    VoiceInput(
                        api = store.apiForHost(composer.key.host),
                        enabled = composerEnabled && !composer.preparing && attachments.none { it is PendingAttachment.File && it.state !is FileUploadState.Ready },
                        onStatus = { voiceStatus = it },
                        onError = { toast.second(it) },
                        onText = { spoken ->
                            val text = listOf(draft.trimEnd(), spoken).filter { it.isNotBlank() }.joinToString("\n")
                            draft = ""
                            send(text)
                        },
                    )
                } },
                onOpenSheet = { sheet = ChatSheet.Commands },
                // A lambda, not `::send`. The composer holds this through rememberUpdatedState,
                // which keeps what it has when the new value is equal to it, and a reference to a
                // local function equals every other reference to that function whatever it
                // captured. Each session's `::send` compared equal to the first and was dropped, so
                // the button went on sending with the attachment list of whichever session was
                // open when this screen first composed. A lambda is rebuilt when what it captures
                // changes and compares by identity, so the composer always holds the current one.
                onSend = { text -> send(text) },
                onStop = { scope.launch { store.cancelTurn() } },
            )

            StatsFooter(stats = sessionStats, usage = tokenUsage)
        }
        DsToastHost(toast, modifier = Modifier.fillMaxWidth())
    }

    }
    panelKey?.let { key -> WorkspacePanels(store, store.panels.get(key), onDismiss = { panelKey = null }) }
    feedback?.let { (key, id, positive) -> FeedbackDialog(store, key, id, positive) { feedback = null } }
    when (sheet) {
        ChatSheet.Commands -> CommandSheet(
            commands = commands,
            commandsAvailable = commandsAvailable,
            skills = skills,
            mode = mode,
            running = conversation?.running == true,
            canAttach = currentSessionId != null && !composer.preparing && !composer.submitting,
            onModeChange = { mode = it },
            onAttach = {
                if (!composer.preparing && store.composers.imagePickTarget == null) {
                    store.composers.imagePickTarget = composer to (imageLimits ?: ImageLimitsView())
                    imagePicker.launch("image/*")
                }
            },
            onAttachFile = { store.composers.filePickTarget = composer; filePicker.launch(arrayOf("*/*")) },
            // The sheet only auto-runs commands that take no input at all, and a command that
            // takes no input takes no attachments either — so a pending attachment refuses here
            // for the same reason it refuses at the composer, rather than being silently dropped.
            onRunCommand = { line ->
                val name = line.removePrefix("/").substringBefore(' ')
                if (attachments.isEmpty()) {
                    scope.launch { report(store.runCommand(line)) }
                } else {
                    toast.second(context.getString(R.string.err_command_no_images, name))
                }
            },
            onPrefillDraft = { prefix -> draft = prefix },
            onDismiss = { sheet = null },
        )
        ChatSheet.Models -> ModelsSheet(models = models, store = store, onDismiss = { sheet = null })
        ChatSheet.Presets -> PresetsSheet(
            presets = agentPresets,
            currentPreset = currentSession?.agentPreset,
            sessionBlank = currentSession?.blank ?: false,
            store = store,
            onDismiss = { sheet = null },
        )
        ChatSheet.Subagents -> SubagentsSheet(
            store = store,
            entries = subagents,
            conversation = subagentConversation,
            mode = subagentMode,
            onDismiss = { sheet = null },
        )
        null -> Unit
    }
}

/** Which sheet, if any, is open over the chat surface. */
private enum class ChatSheet { Commands, Models, Presets, Subagents }

/**
 * A picked document's display name and size, as its provider reports them.
 *
 * The name falls back to the last path segment when the provider offers none, and the size to
 * `-1` — the upload route accepts a chunked body, so an unknown length costs only the progress
 * ring. A null name means the provider answered nothing at all, which is a read failure.
 */
private fun describeDocument(resolver: android.content.ContentResolver, uri: android.net.Uri): Pair<String?, Long> {
    var name: String? = null
    var size = -1L
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (!cursor.moveToFirst()) return@use
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
    }
    return (name ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }) to size
}


/**
 * What a bounds pass over the picked bytes tells us: the image's intrinsic size, the media type
 * its bytes actually are, and a thumbnail for the composer strip.
 *
 * A [width] of zero means the bytes did not parse as an image at all.
 */
internal data class DecodedPick(
    val width: Int,
    val height: Int,
    val detectedMediaType: String?,
    val preview: ImageBitmap?,
)

/**
 * Measure and thumbnail a picked image in one pass.
 *
 * The bounds pass was always here for the thumbnail's sample size; it also answers the two
 * questions the host's admission asks — how large is this, and is it really the type its provider
 * claims — so the picker can refuse an image before spending a round trip on it rather than after.
 */
internal fun decodePick(bytes: ByteArray): DecodedPick {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds) }
    val width = bounds.outWidth.coerceAtLeast(0)
    val height = bounds.outHeight.coerceAtLeast(0)
    val preview = if (width <= 0) {
        null
    } else {
        runCatching {
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(maxOf(width, height), PREVIEW_WIDTH_PX)
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
        }.getOrNull()
    }
    return DecodedPick(if (preview == null) 0 else width, if (preview == null) 0 else height, bounds.outMimeType, preview)
}

/** The composer thumbnail is 56dp; decoding much past that is wasted memory. */
private const val PREVIEW_WIDTH_PX = 224
