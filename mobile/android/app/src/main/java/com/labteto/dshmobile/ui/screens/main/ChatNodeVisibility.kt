package com.labteto.dshmobile.ui.screens.main

import com.labteto.dshmobile.core.session.AssistantMessageNode
import com.labteto.dshmobile.core.session.ChatNode
import com.labteto.dshmobile.core.session.CommandNode
import com.labteto.dshmobile.core.session.CompactionNode
import com.labteto.dshmobile.core.session.DeveloperMessageNode
import com.labteto.dshmobile.core.session.GoalNode
import com.labteto.dshmobile.core.session.OtherNode
import com.labteto.dshmobile.core.session.PlanModeNode
import com.labteto.dshmobile.core.session.RetryNode
import com.labteto.dshmobile.core.session.SubagentNode
import com.labteto.dshmobile.core.session.TitleNode
import com.labteto.dshmobile.core.session.TodoNode
import com.labteto.dshmobile.core.session.ToolCallNode
import com.labteto.dshmobile.core.session.ToolResultNode
import com.labteto.dshmobile.core.session.TurnEndNode
import com.labteto.dshmobile.core.session.TurnErrorNode
import com.labteto.dshmobile.core.session.TurnStartNode
import com.labteto.dshmobile.core.session.UserMessageNode
import com.labteto.dshmobile.core.session.WorkflowNode
import kotlinx.serialization.json.JsonObject

/**
 * Whether [ChatNodeItem] draws anything for this node.
 *
 * The transcript spaces its rows with `Arrangement.spacedBy`, which does not care that an item is
 * zero-height: a node that renders nothing still costs a gap. A single turn folds into twenty-odd
 * of them — turn and step boundaries, request headers, tool results (drawn inside their call's
 * card), assistant chunks — and the gaps stack into a blank band at the top of the viewport. So
 * they are filtered out of the list rather than emitted and hidden.
 *
 * The `when` is exhaustive against [ChatNode] on purpose: a new node type is a compile error here,
 * which is the only thing keeping this in step with [ChatNodeItem]'s own dispatch.
 */
/**
 * The text a user turn renders in its bubble.
 *
 * Shared by [rendersContent] and [ChatNodeItem] so the two cannot disagree about whether a turn has
 * anything to show — a node judged renderable but drawing nothing costs a gap in the transcript, and
 * one judged empty but holding text loses the message.
 *
 * `"unknown"` blocks carrying text count: a harness build that labels a block something this client
 * has not seen should still put the user's words on screen rather than drop them.
 */
internal fun UserMessageNode.displayText(): String = blocks
    .filter { it.kind == "text" || (it.kind == "unknown" && it.text != null) }
    .joinToString("\n") { it.text.orEmpty() }
    .ifBlank { previewText }

internal fun ChatNode.rendersContent(): Boolean = when (this) {
    // Structure, not content.
    is TurnStartNode -> false
    // Rendered inside the matching call's card.
    is ToolResultNode -> false
    // Only an unclean ending says anything; a completed turn is the frame. Kinds [ChatNodeItem]
    // draws nothing for (harness 0.1.7's `forked`, or one this build has never seen) cost a gap.
    is TurnEndNode -> reasonKind in DRAWN_TURN_END_KINDS
    // Bookkeeping event types are not "unknown" — they are noise between the tool calls.
    is OtherNode -> type !in STRUCTURAL_EVENT_TYPES

    // Content that can still fold to nothing.
    is UserMessageNode -> blocks.any { it.kind == "image" } || displayText().isNotBlank()
    is AssistantMessageNode -> interrupted || blocks.any { block ->
        when (block.kind) {
            // Tool calls arrive as their own nodes; the inline block is a duplicate reference.
            "tool-call", "tool-result" -> false
            "text" -> !block.text.isNullOrBlank()
            "reasoning", "image" -> true
            else -> block.text != null
        }
    }
    is TodoNode -> parseTodos(todos) != null
    is GoalNode -> parseGoal(data) != null
    is WorkflowNode -> data is JsonObject
    is DeveloperMessageNode -> addedTools.isNotEmpty() || removedTools.isNotEmpty()

    // Always draws.
    is ToolCallNode -> true
    is PlanModeNode -> true
    is CompactionNode -> true
    is RetryNode -> true
    is TurnErrorNode -> true
    is CommandNode -> true
    is TitleNode -> true
    is SubagentNode -> true
}

/** The `turn/end` reasons [ChatNodeItem] draws something for. */
internal val DRAWN_TURN_END_KINDS = setOf("aborted", "interrupted", "error", "max-tokens")
