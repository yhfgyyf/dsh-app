package com.labteto.dshmobile.ui.screens.main

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.session.SPEECH_SAMPLE_RATE
import com.labteto.dshmobile.core.session.speechWave
import com.labteto.dshmobile.core.wire.DshApiClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*

private class AndroidVoiceCapture : VoiceCapture {
    // Each recording owns its stop flag, so a quick restart cannot revive a cancelled read loop.
    @Volatile private var stop: AtomicBoolean? = null
    @SuppressLint("MissingPermission") // Requested by the microphone button immediately before start.
    override suspend fun record(maxPcmBytes: Int, onReady: () -> Unit): ByteArray {
        val stopped = AtomicBoolean(false)
        stop = stopped
        return withContext(Dispatchers.IO) {
            val minimum = AudioRecord.getMinBufferSize(SPEECH_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(minimum > 0)
            val recorder = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SPEECH_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, 4096))
            try {
                check(recorder.state == AudioRecord.STATE_INITIALIZED)
                ensureActive()
                recorder.startRecording()
                check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING)
                withContext(Dispatchers.Main.immediate) { onReady() }
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(2048)
                while (!stopped.get() && output.size() < maxPcmBytes) {
                    ensureActive()
                    val length = recorder.read(buffer, 0, minOf(buffer.size, maxPcmBytes - output.size()), AudioRecord.READ_NON_BLOCKING)
                    check(length >= 0)
                    if (length > 0) output.write(buffer, 0, length) else delay(15)
                }
                ensureActive()
                speechWave(output.toByteArray())
            } finally {
                runCatching { recorder.stop() }
                recorder.release()
                if (stop === stopped) stop = null
            }
        }
    }
    override fun finish() { stop?.set(true) }
    override fun cancel() { stop?.set(true) }
}

@Composable
internal fun VoiceInput(
    api: DshApiClient?,
    enabled: Boolean,
    onText: (String) -> Unit,
    onStatus: (String?) -> Unit,
    onError: (String) -> Unit,
    finishLabel: String? = null,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val currentEnabled by rememberUpdatedState(enabled)
    val currentText by rememberUpdatedState(onText)
    val currentStatus by rememberUpdatedState(onStatus)
    val currentError by rememberUpdatedState(onError)
    val controller = remember(api) { api?.let { VoiceInputController(scope, it, AndroidVoiceCapture(),
        { text -> currentText(text) }, { problem -> currentError(context.getString(when (problem) {
            VoiceProblem.SETUP -> R.string.voice_setup_needed
            VoiceProblem.EMPTY -> R.string.voice_empty
            VoiceProblem.FAILED -> R.string.voice_failed
        })) }) } }
    val phase = controller?.phase?.collectAsStateWithLifecycle()?.value ?: VoicePhase.IDLE
    val status = when (phase) {
        VoicePhase.IDLE -> null
        VoicePhase.CHECKING -> stringResource(R.string.voice_checking)
        VoicePhase.RECORDING -> stringResource(R.string.voice_recording)
        VoicePhase.TRANSCRIBING -> stringResource(R.string.voice_transcribing)
    }
    SideEffect { currentStatus(status) }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) controller?.cancel() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller?.cancel(); currentStatus(null) }
    }
    LaunchedEffect(enabled) { if (!enabled) controller?.cancel() }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && currentEnabled) controller?.start()
        else if (!granted) currentError(context.getString(R.string.voice_permission_needed))
    }
    Row {
        IconButton(enabled = controller != null && enabled && phase in setOf(VoicePhase.IDLE, VoicePhase.RECORDING), onClick = {
            if (phase == VoicePhase.RECORDING) controller?.finish()
            else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) controller?.start()
            else permission.launch(Manifest.permission.RECORD_AUDIO)
        }) {
            if (phase in setOf(VoicePhase.CHECKING, VoicePhase.TRANSCRIBING)) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
            else Icon(if (phase == VoicePhase.RECORDING) Icons.Filled.Stop else Icons.Filled.Mic,
                if (phase == VoicePhase.RECORDING && finishLabel != null) finishLabel else stringResource(if (phase == VoicePhase.RECORDING) R.string.voice_finish_send else R.string.voice_start))
        }
        if (phase != VoicePhase.IDLE) IconButton(onClick = { controller?.cancel() }) {
            Icon(Icons.Filled.Close, stringResource(R.string.common_cancel))
        }
    }
}
