package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.session.speechWave
import com.labteto.dshmobile.core.wire.*
import java.io.InputStream
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceInputControllerTest {
    private class Capture : VoiceCapture {
        val recording = CompletableDeferred<ByteArray>()
        var starts = 0
        var cancelled = false
        override suspend fun record(maxPcmBytes: Int, onReady: () -> Unit): ByteArray {
            assertEquals(3_840_000, maxPcmBytes)
            starts++; onReady()
            return recording.await()
        }
        override fun finish() { recording.complete(speechWave(ByteArray(32000))) }
        override fun cancel() { cancelled = true }
    }
    private class Host(var text: String = "  测试语音  ", var location: String = "host-local", var readiness: String = "ready") : RpcTransport {
        val paths = mutableListOf<String>()
        var transcriptionGate: CompletableDeferred<Unit>? = null
        override suspend fun post(path: String, body: String): RpcHttpResponse {
            paths.add(path)
            val envelope = Json.parseToJsonElement(body).jsonObject
            val id = envelope.getValue("rpcId")
            val value = when (path) {
                "/api/speech/catalog" -> """{"providers":[{"id":"local","name":"Local","location":"$location","languages":["auto"],"preparation":{"phase":"$readiness"}}],"selection":{"providerId":"local","language":"auto"},"maxAudioBytes":4194304,"maxDurationSeconds":120}"""
                "/api/speech/prepare" -> { readiness = "ready"; "null" }
                "/api/speech/transcribe" -> {
                    val request = envelope.getValue("payload").jsonObject.getValue("args").jsonObject.getValue("request").jsonObject
                    assertEquals("local", request.getValue("providerId").jsonPrimitive.content)
                    assertEquals("auto", request.getValue("language").jsonPrimitive.content)
                    assertArrayEquals(speechWave(ByteArray(32000)), java.util.Base64.getDecoder().decode(request.getValue("audioBase64").jsonPrimitive.content))
                    transcriptionGate?.await()
                    """{"text":${JsonPrimitive(text)},"audioSeconds":1,"inferenceSeconds":0.1}"""
                }
                else -> error("Voice must never run commands or create a realtime connection: $path")
            }
            return RpcHttpResponse(200, """{"type":"server-response","rpcId":$id,"result":{"ok":true,"value":$value}}""")
        }
        override suspend fun <T> download(path: String, consume: (String?, String?, InputStream) -> T): T = error("unused")
        override suspend fun upload(path: String, contentType: String, contentLength: Long, body: InputStream, onProgress: ((Long) -> Unit)?): RpcHttpResponse = error("unused")
    }

    @Test fun `finishing a recording transcribes and automatically submits exactly once`() = runTest {
        val host = Host(); val capture = Capture(); val sent = mutableListOf<String>()
        val controller = VoiceInputController(this, DshApiClient(host), capture, { sent.add(it) }, { fail("Unexpected $it") })
        controller.start(); controller.start(); runCurrent()
        assertEquals(VoicePhase.RECORDING, controller.phase.value)
        assertEquals(1, capture.starts); assertTrue(sent.isEmpty())
        controller.finish(); controller.finish(); advanceUntilIdle()
        assertEquals(listOf("测试语音"), sent)
        assertEquals(1, host.paths.count { it == "/api/speech/transcribe" })
        assertEquals(VoicePhase.IDLE, controller.phase.value)
    }

    @Test fun `cancel during recording or transcription never submits a late result`() = runTest {
        for (duringTranscription in listOf(false, true)) {
            val host = Host().apply { transcriptionGate = CompletableDeferred() }
            val capture = Capture(); val sent = mutableListOf<String>()
            val controller = VoiceInputController(this, DshApiClient(host), capture, { sent.add(it) }, { fail("Unexpected $it") })
            controller.start(); runCurrent()
            if (duringTranscription) { controller.finish(); runCurrent(); assertEquals(VoicePhase.TRANSCRIBING, controller.phase.value) }
            controller.cancel(); host.transcriptionGate!!.complete(Unit); capture.finish(); advanceUntilIdle()
            assertTrue(capture.cancelled); assertTrue(sent.isEmpty()); assertEquals(VoicePhase.IDLE, controller.phase.value)
        }
    }

    @Test fun `silence is not sent and an unprepared or cloud recognizer never records`() = runTest {
        for (host in listOf(Host(text = " \n "), Host(location = "cloud"), Host(readiness = "unprepared"))) {
            val capture = Capture(); val problems = mutableListOf<VoiceProblem>()
            val controller = VoiceInputController(this, DshApiClient(host), capture, { fail("Must not send") }, { problems.add(it) })
            controller.start(); runCurrent(); controller.finish(); advanceUntilIdle()
            val empty = host.text.isBlank()
            assertEquals(if (empty) 1 else 0, capture.starts)
            assertEquals(listOf(if (empty) VoiceProblem.EMPTY else VoiceProblem.SETUP), problems)
        }
    }

    @Test fun `an already downloaded recognizer is woken on the computer`() = runTest {
        val host = Host(readiness = "standby"); val capture = Capture()
        val controller = VoiceInputController(this, DshApiClient(host), capture, {}, { fail("Unexpected $it") })
        controller.start(); runCurrent()
        assertEquals(1, host.paths.count { it == "/api/speech/prepare" })
        assertEquals(VoicePhase.RECORDING, controller.phase.value)
        controller.cancel(); advanceUntilIdle()
    }
}
