package com.labteto.dshmobile.core.wire

import com.labteto.dshmobile.core.session.AssistantLiveState
import com.labteto.dshmobile.core.session.AssistantMessageNode
import com.labteto.dshmobile.core.session.EventFold
import com.labteto.dshmobile.core.session.SessionEventEnvelope
import com.labteto.dshmobile.core.session.UserMessageNode
import com.labteto.dshmobile.core.wire.dto.*
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Decode the actual encrypted-phone integration capture with the shipped Android client. */
class CodexBridgeFixtureTest {
    @Test fun bridgeCaptureRendersHistoryAndRestoresPartialAnswer() {
        val path = System.getenv("CODEX_COLLAB_WIRE_FIXTURE")
        assumeTrue("Run services/codex-collab tests and set CODEX_COLLAB_WIRE_FIXTURE", path != null)
        val capture = WireJson.parseToJsonElement(File(path!!).readText()).jsonObject
        val resumed = decodeFromJsonElement(SessionFollowFrameSerializer, capture.getValue("resumed")) as SessionFollowFrame.Snapshot
        val older = decodeFromJsonElement(SessionPage.serializer(), capture.getValue("older"))
        val records = older.records + resumed.records
        assertEquals(records.map { it.event.seq }.distinct().size, records.size)
        val events = records.map { r ->
            val e = r.event
            SessionEventEnvelope(e.type, e.seq.toLong(), e.time, e.data)
        }
        val history = EventFold("codex").fold(events)
        assertTrue(history.nodes.any { it is UserMessageNode })
        assertTrue(history.nodes.any { it is AssistantMessageNode })
        val image = decodeFromJsonElement(SessionAttachmentValue.serializer(), capture.getValue("image"))
        assertEquals(1, image.attachment.width)
        assertEquals(1, image.attachment.height)
        assertTrue(image.data.isNotEmpty())
        val userParts = records.filter { it.event.type == "user/message" }.flatMap {
            decodeFromJsonElement(MessageData.serializer(), it.event.data).content
        }
        assertTrue(userParts.any { it is ContentBlock.Image })
        assertTrue(userParts.any { it is ContentBlock.File })
        val live = AssistantLiveState()
        live.seed(resumed.assistantStream!!)
        assertTrue(live.transientEnvelopes().isNotEmpty())
        val frames = capture.getValue("frames").jsonArray.map { it.jsonObject }
        val firstStream = frames.filter { it["streamId"]?.jsonPrimitive?.content == "follow" }
            .map { decodeFromJsonElement(SessionFollowFrameSerializer, it.getValue("value")) }
        assertTrue(firstStream.any { it is SessionFollowFrame.AssistantStream })
        val ending = frames.filter { it["streamId"]?.jsonPrimitive?.content == "follow-again" }
            .map { decodeFromJsonElement(SessionFollowFrameSerializer, it.getValue("value")) }
        for (frame in ending) if (frame is SessionFollowFrame.AssistantStream) live.accept(frame.frame)
        assertTrue(live.transientEnvelopes().isEmpty())
    }
}
