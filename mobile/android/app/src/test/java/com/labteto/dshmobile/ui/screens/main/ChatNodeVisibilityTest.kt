package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.session.AssistantMessageNode
import com.labteto.dshmobile.core.session.ChatBlock
import com.labteto.dshmobile.core.session.OtherNode
import com.labteto.dshmobile.core.session.ToolCallNode
import com.labteto.dshmobile.core.session.ToolResultNode
import com.labteto.dshmobile.core.session.TurnEndNode
import com.labteto.dshmobile.core.session.TurnStartNode
import com.labteto.dshmobile.core.session.UserMessageNode
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A node that draws nothing must not reach the transcript's list.
 *
 * The list spaces its rows with `Arrangement.spacedBy`, which happily puts 4dp between two
 * zero-height items — so a turn's worth of bookkeeping events stacks into a visible white band
 * above the conversation. These pin the predicate that keeps them out.
 */
class ChatNodeVisibilityTest {

    @Test
    fun `structural nodes draw nothing`() {
        assertFalse(TurnStartNode(seq = 1, turn = 1).rendersContent())
        assertFalse(
            ToolResultNode(seq = 2, callId = "c", content = null, isError = false, turn = 1, step = 1)
                .rendersContent(),
        )
        assertFalse(TurnEndNode(seq = 3, turn = 1, reasonKind = "completed").rendersContent())
    }

    @Test
    fun `an unclean turn ending is worth a row`() {
        assertTrue(TurnEndNode(seq = 3, turn = 1, reasonKind = "interrupted").rendersContent())
        assertTrue(TurnEndNode(seq = 3, turn = 1, reasonKind = "error").rendersContent())
    }

    @Test
    fun `bookkeeping event types are filtered, unknown ones survive`() {
        // The compatibility contract keeps genuinely unknown types visible; the noise is named.
        assertFalse(OtherNode(seq = 4, type = "step/start", data = JsonNull).rendersContent())
        assertFalse(OtherNode(seq = 5, type = "assistant/chunk", data = JsonNull).rendersContent())
        assertTrue(OtherNode(seq = 6, type = "something/new", data = JsonNull).rendersContent())
    }

    @Test
    fun `an assistant message of nothing but tool references draws nothing`() {
        val node = AssistantMessageNode(
            seq = 7,
            messageId = null,
            turn = 1,
            step = 1,
            blocks = listOf(
                ChatBlock(kind = "tool-call", toolCallId = "c", toolName = "bash"),
                ChatBlock(kind = "text", text = "   "),
            ),
        )
        assertFalse(node.rendersContent())
        assertTrue(node.copy(blocks = node.blocks + ChatBlock("text", "done")).rendersContent())
        assertTrue(node.copy(interrupted = true).rendersContent())
    }

    @Test
    fun `an empty user message draws nothing`() {
        val node = UserMessageNode(seq = 8, messageId = null, blocks = emptyList(), sourceKind = "user")
        assertFalse(node.rendersContent())
        assertTrue(node.copy(blocks = listOf(ChatBlock("text", "hello"))).rendersContent())
    }

    /**
     * A harness that labels a block something this client has not seen should still put the user's
     * words on screen. The predicate and the renderer share [displayText] so they cannot disagree
     * about it — a node judged renderable that then draws nothing costs a gap, and one judged empty
     * that holds text loses the message.
     */
    @Test
    fun `an unknown block carrying text still counts as a user message`() {
        val node = UserMessageNode(
            seq = 9,
            messageId = null,
            blocks = listOf(ChatBlock("unknown", text = "typed this")),
            sourceKind = "user",
        )
        assertTrue(node.rendersContent())
        assertEquals("typed this", node.displayText())
    }

    @Test
    fun `an unknown block with no text is still nothing to draw`() {
        val node = UserMessageNode(
            seq = 10,
            messageId = null,
            blocks = listOf(ChatBlock("unknown", text = null)),
            sourceKind = "user",
        )
        assertFalse(node.rendersContent())
        assertEquals("", node.displayText())
    }

    @Test
    fun `multiple text blocks join in order`() {
        val node = UserMessageNode(
            seq = 11,
            messageId = null,
            blocks = listOf(ChatBlock("text", "one"), ChatBlock("text", "two")),
            sourceKind = "user",
        )
        assertEquals("one\ntwo", node.displayText())
    }

    @Test
    fun `a turn exposes request context alongside tool calls`() {
        val nodes = listOf(
            TurnStartNode(seq = 1, turn = 1),
            OtherNode(seq = 2, type = "step/start", data = JsonNull),
            OtherNode(seq = 3, type = "request/header", data = JsonNull),
            OtherNode(seq = 4, type = "request/context", data = JsonNull),
            ToolCallNode(seq = 5, callId = "c1", name = "bash", arguments = "{}", turn = 1, step = 1),
            ToolResultNode(seq = 6, callId = "c1", content = null, isError = false, turn = 1, step = 1),
            OtherNode(seq = 7, type = "step/end", data = JsonNull),
            TurnEndNode(seq = 8, turn = 1, reasonKind = "completed"),
        )
        assertEquals(listOf(3L, 4L, 5L), nodes.filter { it.rendersContent() }.map { it.seq })
    }
}
