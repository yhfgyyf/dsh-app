package com.labteto.dshmobile.mockharness

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The acceptance law this mock stands in for.
 *
 * Every case here is one the real proxy decides the same way. They are worth pinning because the
 * consequence of getting one wrong is invisible from the client: a refused batch leaves the host's
 * wait open and the `ask_user_question` call that opened it blocked, with no error anywhere.
 */
class QuestionAcceptanceTest {

    private fun questions(json: String) = Json.parseToJsonElement(json) as JsonArray

    private val single = questions(
        """[{"id":"a","question":"Which?","options":[{"label":"Alpha"},{"label":"Beta"}]}]""",
    )

    private val multi = questions(
        """[{"id":"a","question":"Which?","multiSelect":true,
             "options":[{"label":"Alpha"},{"label":"Beta"}]}]""",
    )

    private fun judge(
        body: String,
        sessionId: String = "s1",
        asked: JsonArray = single,
    ): QuestionReceipt = judgeQuestionResponse(
        Json.parseToJsonElement(body) as JsonObject,
        PendingQuestion(sessionId, asked),
    )

    private fun answer(value: String) =
        """{"type":"client-response","rpcId":"q1","result":{"ok":true,"value":$value}}"""

    @Test
    fun `a well-formed single choice is accepted`() {
        val receipt = judge(answer("""{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":["Alpha"]}]}}"""))
        assertEquals(QuestionReceipt.Accepted, receipt)
    }

    @Test
    fun `an answer count that differs from the question count is refused`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[
                 {"id":"a","selected":["Alpha"]},{"id":"b","selected":[]}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `answers are paired with questions by position, not by id`() {
        val asked = questions("""[{"id":"a","question":"?"},{"id":"b","question":"?"}]""")
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[
                 {"id":"b","selected":[]},{"id":"a","selected":[]}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body, asked = asked))
    }

    @Test
    fun `a repeated label is refused`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":["Alpha","Alpha"]}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body, asked = multi))
    }

    @Test
    fun `a label the question never offered is refused`() {
        val body = answer("""{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":["Ghost"]}]}}""")
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `free text that is empty after trimming is refused`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":[],"custom":"  "}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `a single-select answer carrying both a selection and free text is refused`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":["Alpha"],"custom":"and"}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `a single-select answer carrying two labels is refused`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":["Alpha","Beta"]}]}}""",
        )
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `a multi-select answer may carry both a selection and free text`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[
                 {"id":"a","selected":["Alpha","Beta"],"custom":"and this"}]}}""",
        )
        assertEquals(QuestionReceipt.Accepted, judge(body, asked = multi))
    }

    @Test
    fun `a mismatched sessionId is refused`() {
        val body = answer("""{"sessionId":"s2","answer":{"answers":[{"id":"a","selected":["Alpha"]}]}}""")
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(body))
    }

    @Test
    fun `an ok-false response is accepted only when the code is cancelled`() {
        val cancelled = """{"type":"client-response","rpcId":"q1","result":{"ok":false,
            "error":{"code":"cancelled","message":"the user closed this question request","details":{}}}}"""
        assertEquals(QuestionReceipt.Accepted, judge(cancelled))

        val other = """{"type":"client-response","rpcId":"q1","result":{"ok":false,
            "error":{"code":"internal","message":"nope","details":{}}}}"""
        assertEquals(QuestionReceipt.Refused("bad-response"), judge(other))
    }

    /**
     * The failure this whole port exists for.
     *
     * The shape the app used to send put `custom` beside the answer list rather than on the answer.
     * The schema does not declare it there, so it is stripped, and what is left validates — the
     * response comes back accepted and the user's typed text is simply gone. Nothing on either side
     * reports anything, which is why only a stand-in that models the strip can catch it.
     */
    @Test
    fun `free text written beside the answer list is stripped, and the answer still passes`() {
        val body = answer(
            """{"sessionId":"s1","answer":{"answers":[{"id":"a","selected":[]}],"custom":"my own words"}}""",
        )
        assertEquals(QuestionReceipt.Accepted, judge(body))
    }
}
