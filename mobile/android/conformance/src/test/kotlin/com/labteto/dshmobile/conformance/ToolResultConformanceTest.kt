package com.labteto.dshmobile.conformance

import com.labteto.dshmobile.core.session.EventFold
import com.labteto.dshmobile.core.session.SessionEventEnvelope
import com.labteto.dshmobile.core.session.ToolCallNode
import com.labteto.dshmobile.core.session.ToolResultNode
import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.core.wire.WireJson
import com.labteto.dshmobile.core.wire.dto.PromptContentPart
import com.labteto.dshmobile.core.wire.dto.SessionAddress
import com.labteto.dshmobile.core.wire.dto.SessionCreateRequest
import com.labteto.dshmobile.core.wire.dto.SessionFollowFrame
import com.labteto.dshmobile.core.wire.dto.SessionFollowRequest
import com.labteto.dshmobile.core.wire.dto.SessionPromptRequest
import com.labteto.dshmobile.core.wire.dto.SessionWireEvent
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.util.UUID

/**
 * A real tool call and its result, folded by the shipped fold.
 *
 * Session format v4 (harness 0.1.7) moved a `tool/result`'s call id and error flag from a wrapper
 * block inside the content onto the message itself. A fold that still reads the wrapper does not
 * crash: it produces results with an empty call id, which pair with nothing, so every tool card
 * silently loses its output. Only a real log shows which shape a harness writes, which is why this
 * drives a turn instead of asserting against a transcription.
 *
 * The model is scripted to call a tool that does not exist. The harness still records the call
 * and answers it with a failed result, which is all this needs, and it cannot wait on an approval
 * or touch the filesystem.
 */
class ToolResultConformanceTest {

    private lateinit var model: MockModel
    private lateinit var harness: HarnessProcess
    private lateinit var client: HarnessClient

    @Before
    fun boot() {
        assumeTrue("no built harness checkout; see HarnessProcess", HarnessProcess.available())
        model = MockModel.start(
            sequence = listOf("tool_call_success", "success"),
            toolName = TOOL,
            toolArguments = "{}",
        )
        harness = HarnessProcess.start(model)
        client = HarnessClient(harness)
    }

    @After
    fun stop() {
        if (this::client.isInitialized) client.close()
        if (this::harness.isInitialized) harness.close()
        if (this::model.isInitialized) model.close()
    }

    @Test
    fun `a tool result from a real turn pairs with its call`() = runBlocking {
        val created = client.api.sessionCreate(SessionCreateRequest(cwd = harness.workspacePath))
        val sessionId = (created as? RpcResult.Ok)?.value?.sessionId ?: error("could not create a session: $created")

        client.mux.start()
        withTimeout(BUDGET_MS) { client.mux.awaitOpen() }
        val follow = client.mux.open(
            "session/follow",
            buildJsonObject {
                put(
                    "request",
                    WireJson.encodeToJsonElement(
                        SessionFollowRequest.serializer(),
                        SessionFollowRequest(SessionAddress.Session(sessionId = sessionId), maxMessages = 50),
                    ),
                )
            },
        )
        val events = mutableListOf<SessionEventEnvelope>()
        try {
            val prompt = client.api.sessionPrompt(
                SessionPromptRequest(
                    requestId = UUID.randomUUID().toString(),
                    sessionId = sessionId,
                    mode = "queue",
                    content = listOf(PromptContentPart.Text("call the tool")),
                ),
            )
            assertTrue("the prompt was refused: $prompt", prompt is RpcResult.Ok)

            withTimeout(TURN_BUDGET_MS) {
                while (events.none { it.type == "turn/end" }) {
                    val raw = follow.receive() ?: error("session/follow ended before the turn did")
                    when (val frame = WireJson.decodeFromJsonElement(SessionFollowFrame.serializer(), raw)) {
                        is SessionFollowFrame.Snapshot -> frame.records.forEach { events += envelope(it.event) }
                        is SessionFollowFrame.Entry -> events += envelope(frame.record.event)
                        is SessionFollowFrame.AssistantStream -> Unit
                    }
                }
            }
        } finally {
            follow.cancel()
        }

        val nodes = EventFold(sessionId).fold(events.sortedBy { it.seq }.distinctBy { it.seq }).nodes
        val call = nodes.filterIsInstance<ToolCallNode>().singleOrNull { it.name == TOOL }
            ?: error("no call to $TOOL in ${events.map { it.type }}")
        val result = nodes.filterIsInstance<ToolResultNode>().singleOrNull()
            ?: error("no single tool result in ${events.map { it.type }}")
        assertEquals("the result names the call it answers", call.callId, result.callId)
        assertTrue("a call to a tool that does not exist fails", result.isError)
    }

    private fun envelope(event: SessionWireEvent) = SessionEventEnvelope(
        type = event.type,
        seq = event.seq.toLong(),
        time = event.time,
        data = event.data,
        surfaceOp = (event.surfaceOp as? JsonPrimitive)?.contentOrNull,
    )

    private companion object {
        const val TOOL = "conformance_missing_tool"
        const val BUDGET_MS = 10_000L
        const val TURN_BUDGET_MS = 90_000L
    }
}
