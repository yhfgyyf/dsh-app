package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.session.SPEECH_SAMPLE_RATE
import com.labteto.dshmobile.core.session.WAVE_HEADER_BYTES
import com.labteto.dshmobile.core.wire.DshApiClient
import com.labteto.dshmobile.core.wire.dto.SpeechTranscriptionRequest
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal enum class VoicePhase { IDLE, CHECKING, RECORDING, TRANSCRIBING }
internal enum class VoiceProblem { SETUP, EMPTY, FAILED }

internal interface VoiceCapture {
    suspend fun record(maxPcmBytes: Int, onReady: () -> Unit): ByteArray
    fun finish()
    fun cancel()
}

/** One recording, one host transcription, at most one submission. Cancellation retires the result. */
internal class VoiceInputController(
    private val scope: CoroutineScope,
    private val api: DshApiClient,
    private val capture: VoiceCapture,
    private val submit: (String) -> Unit,
    private val failed: (VoiceProblem) -> Unit,
) {
    private val mutablePhase = MutableStateFlow(VoicePhase.IDLE)
    val phase = mutablePhase.asStateFlow()
    private var job: Job? = null
    private var generation = 0

    fun start() {
        if (job?.isActive == true) return
        val current = ++generation
        mutablePhase.value = VoicePhase.CHECKING
        job = scope.launch {
            try {
                val catalog = api.speechCatalog().requireValue()
                val provider = catalog.providers.firstOrNull { it.id == catalog.selection.providerId && it.location == "host-local" }
                if (provider == null || provider.preparation.phase in setOf("unprepared", "cancelled", "failed")) {
                    failed(VoiceProblem.SETUP); return@launch
                }
                if (provider.preparation.phase != "ready") {
                    // Standby means the model is already on this computer. Wake it without downloading.
                    if (provider.preparation.phase == "standby") api.speechPrepare(provider.id).requireValue()
                    withTimeout(60_000) {
                        while (true) {
                            val state = api.speechCatalog().requireValue().providers.firstOrNull { it.id == provider.id }
                            if (state?.preparation?.phase == "ready") break
                            if (state == null || state.preparation.phase in setOf("unprepared", "failed", "cancelled")) error("speech unavailable")
                            delay(300)
                        }
                    }
                }
                val duration = catalog.maxDurationSeconds.coerceIn(0.0, 120.0)
                val maxPcmBytes = minOf((duration * SPEECH_SAMPLE_RATE * 2).toInt(), catalog.maxAudioBytes - WAVE_HEADER_BYTES, 4 * 1024 * 1024 - WAVE_HEADER_BYTES).let { it - it % 2 }
                require(maxPcmBytes >= SPEECH_SAMPLE_RATE * 2)
                val audio = capture.record(maxPcmBytes) { if (current == generation) mutablePhase.value = VoicePhase.RECORDING }
                currentCoroutineContext().ensureActive()
                if (current != generation) return@launch
                mutablePhase.value = VoicePhase.TRANSCRIBING
                val transcript = api.speechTranscribe(SpeechTranscriptionRequest(
                    Base64.getEncoder().encodeToString(audio), provider.id, catalog.selection.language,
                )).requireValue().text.trim()
                currentCoroutineContext().ensureActive()
                if (current != generation) return@launch
                if (transcript.isEmpty()) failed(VoiceProblem.EMPTY) else submit(transcript)
            } catch (_: TimeoutCancellationException) { if (current == generation) failed(VoiceProblem.FAILED) }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { if (current == generation) failed(VoiceProblem.FAILED) }
            finally { if (current == generation) { mutablePhase.value = VoicePhase.IDLE; job = null } }
        }
    }

    fun finish() { if (mutablePhase.value == VoicePhase.RECORDING) capture.finish() }
    fun cancel() {
        generation++
        job?.cancel(); job = null
        capture.cancel()
        mutablePhase.value = VoicePhase.IDLE
    }
}
