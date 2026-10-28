package com.labteto.dshmobile.ui.components

import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionItem
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionOption
import com.labteto.dshmobile.core.wire.encodeToString
import com.labteto.dshmobile.mockharness.PendingQuestion
import com.labteto.dshmobile.mockharness.QuestionReceipt
import com.labteto.dshmobile.mockharness.judgeQuestionResponse
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The encoder, judged by the host's own rules.
 *
 * The unit tests next door pin each clause of the encoding; this one asks the other question — is
 * what comes out actually accepted? It matters because the two failures this work fixes are both
 * silent from the client's side. A refused batch leaves the wait open and the tool blocked with no
 * error to show; an accepted-but-stripped one looks like a success and reaches the model with the
 * user's typed answer missing. Only a stand-in that models both can tell them apart.
 */
class QuestionAnswerConformanceTest {

    private val questions = listOf(
        AskUserQuestionItem(
            id = "approach",
            question = "Which approach?",
            options = listOf(
                AskUserQuestionOption("Rewrite (Recommended)"),
                AskUserQuestionOption("Patch"),
            ),
        ),
        AskUserQuestionItem(
            id = "signals",
            question = "What should it watch?",
            options = listOf(AskUserQuestionOption("Latency"), AskUserQuestionOption("Errors")),
            multiSelect = true,
        ),
        AskUserQuestionItem(id = "notes", question = "Anything else?"),
    )

    private val pending = PendingQuestion(
        sessionId = "s1",
        questions = Json.parseToJsonElement(
            encodeToString(kotlinx.serialization.builtins.ListSerializer(AskUserQuestionItem.serializer()), questions),
        ) as JsonArray,
    )

    private fun judge(answer: AskUserQuestionAnswer): QuestionReceipt = judgeEnvelope(
        """{"sessionId":"s1","answer":${encodeToString(AskUserQuestionAnswer.serializer(), answer)}}""",
    )

    private fun judgeEnvelope(value: String): QuestionReceipt = judgeQuestionResponse(
        Json.parseToJsonElement(
            """{"type":"client-response","rpcId":"q1","result":{"ok":true,"value":$value}}""",
        ) as JsonObject,
        pending,
    )

    @Test
    fun `a batch of a choice, a multiple choice and free text is accepted`() {
        val drafts = listOf(
            QuestionDraft(selected = listOf("Rewrite (Recommended)")),
            QuestionDraft(selected = listOf("Latency", "Errors"), custom = "and saturation"),
            QuestionDraft(custom = "ship it on Friday"),
        )
        assertEquals(QuestionReceipt.Accepted, judge(encodeAnswers(questions, drafts)))
    }

    @Test
    fun `free text on a single-choice question is accepted because it drops the selection`() {
        val drafts = listOf(
            QuestionDraft(selected = listOf("Patch"), custom = "neither, actually"),
            QuestionDraft(skipped = true),
            QuestionDraft(skipped = true),
        )
        assertEquals(QuestionReceipt.Accepted, judge(encodeAnswers(questions, drafts)))
    }

    @Test
    fun `a wholly skipped batch is still a complete answer`() {
        val drafts = questions.map { QuestionDraft(skipped = true) }
        assertEquals(QuestionReceipt.Accepted, judge(encodeAnswers(questions, drafts)))
    }

    @Test
    fun `the recommendation marker travels intact, because the host checks the label it sent`() {
        val drafts = listOf(
            QuestionDraft(selected = listOf("Rewrite (Recommended)")),
            QuestionDraft(skipped = true),
            QuestionDraft(skipped = true),
        )
        assertEquals(QuestionReceipt.Accepted, judge(encodeAnswers(questions, drafts)))

        // Sending the stripped display label instead would name no option the request offered.
        val stripped = """{"answers":[{"id":"approach","selected":["Rewrite"]},
            {"id":"signals","selected":[]},{"id":"notes","selected":[]}]}"""
        assertEquals(
            QuestionReceipt.Refused("bad-response"),
            judgeEnvelope("""{"sessionId":"s1","answer":$stripped}"""),
        )
    }

    /**
     * The shape this app used to send, kept as a specimen.
     *
     * One `custom` for the whole batch, written beside the answer list. The host's schema does not
     * declare it there, so it is dropped before validation — and what remains is a perfectly valid
     * answer. The response is accepted, nothing anywhere reports a problem, and the model receives
     * three empty answers. That is the bug, and this is what it looked like on the wire.
     */
    @Test
    fun `the shape this app used to send is accepted with the typed answer already gone`() {
        val old = """{"answers":[{"id":"approach","selected":[]},{"id":"signals","selected":[]},
            {"id":"notes","selected":[]}],"custom":"ship it on Friday"}"""
        assertEquals(
            QuestionReceipt.Accepted,
            judgeEnvelope("""{"sessionId":"s1","answer":$old}"""),
        )
    }

    @Test
    fun `answering only the question a plan-review card renders would block the tool`() {
        // What the old routing did to a batch that merely contained a plan-review intent.
        val partial = """{"answers":[{"id":"approach","selected":["Patch"]}]}"""
        assertEquals(
            QuestionReceipt.Refused("bad-response"),
            judgeEnvelope("""{"sessionId":"s1","answer":$partial}"""),
        )
    }
}
