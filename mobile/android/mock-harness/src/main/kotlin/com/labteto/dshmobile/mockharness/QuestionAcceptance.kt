package com.labteto.dshmobile.mockharness

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The harness's own acceptance law for a question response, ported so this mock can enforce it.
 *
 * A stand-in that answers `{"accepted":true}` to anything is not a stand-in for a host that
 * validates. The real proxy checks an answer batch against the exact request it resolves
 * (`matchesQuestions`, `packages/host/apiproxy/src/api-proxy.ts`) and refuses the lot on any single
 * violation, leaving the tool call blocked; and before that it parses the payload with a schema
 * that *strips* keys it does not declare rather than objecting to them. That combination is what
 * let a malformed client answer look successful while the user's typed text was quietly deleted in
 * transit, so both halves are modelled here — the strip as well as the check.
 */

/** A question request this mock has pushed and is waiting on. */
data class PendingQuestion(val sessionId: String, val questions: JsonArray)

/** What the host would answer a `POST /api/respond` carrying a question response. */
sealed interface QuestionReceipt {
    data object Accepted : QuestionReceipt

    /** `bad-response` (malformed for this request) or `not-pending` (already settled). */
    data class Refused(val reason: String) : QuestionReceipt
}

/** One answer item after the schema parse: the only three fields that survive it. */
private data class ParsedAnswer(val id: String, val selected: List<String>, val custom: String?)

/**
 * Judge one `client-response` envelope against the request it claims to resolve.
 *
 * @param envelope the whole POST body.
 * @param pending the request that rpcId is waiting on.
 */
fun judgeQuestionResponse(envelope: JsonObject, pending: PendingQuestion): QuestionReceipt {
    val result = envelope["result"] as? JsonObject ?: return badResponse()
    val ok = (result["ok"] as? JsonPrimitive)?.booleanOrNull ?: return badResponse()

    if (!ok) {
        // A rejection settles the wait as cancelled — but only that one code. Any other is a
        // client sending a failure the host has no rule for, which is itself a bad response.
        val code = ((result["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
        return if (code == "cancelled") QuestionReceipt.Accepted else badResponse()
    }

    val payload = result["value"] as? JsonObject ?: return badResponse()
    val sessionId = (payload["sessionId"] as? JsonPrimitive)?.contentOrNull ?: return badResponse()
    val answers = parseAnswers(payload["answer"]) ?: return badResponse()
    return if (matches(sessionId, answers, pending)) QuestionReceipt.Accepted else badResponse()
}

private fun badResponse() = QuestionReceipt.Refused("bad-response")

/**
 * The schema parse: required fields are enforced, everything else is dropped on the floor.
 *
 * Dropping is the load-bearing half. A `custom` written beside the answer list instead of on an
 * answer disappears here without a word — the response still parses, still matches, and is still
 * accepted, with the free text gone.
 */
private fun parseAnswers(answer: JsonElement?): List<ParsedAnswer>? {
    val list = (answer as? JsonObject)?.get("answers") as? JsonArray ?: return null
    return list.map { element ->
        val item = element as? JsonObject ?: return null
        val id = (item["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val selectedArray = item["selected"] as? JsonArray ?: return null
        val selected = selectedArray.map { value ->
            (value as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        }
        val custom = when (val raw = item["custom"]) {
            null -> null
            is JsonPrimitive -> if (raw.isString) raw.content else return null
            else -> return null
        }
        ParsedAnswer(id, selected, custom)
    }
}

/** The seven rules, in the order the host applies them. */
private fun matches(
    sessionId: String,
    answers: List<ParsedAnswer>,
    pending: PendingQuestion,
): Boolean {
    if (sessionId != pending.sessionId) return false
    if (answers.size != pending.questions.size) return false
    return answers.withIndex().all { (index, answer) ->
        val question = pending.questions[index] as? JsonObject ?: return false
        // Paired by position, not by id: an answer list in a different order is refused even when
        // every id it carries is one the request asked about.
        if (answer.id != (question["id"] as? JsonPrimitive)?.contentOrNull) return false
        if (answer.selected.toSet().size != answer.selected.size) return false
        val custom = answer.custom?.trim()
        if (custom != null && custom.isEmpty()) return false
        val multiSelect = (question["multiSelect"] as? JsonPrimitive)?.booleanOrNull == true
        if (!multiSelect) {
            if (custom != null && answer.selected.isNotEmpty()) return false
            if (answer.selected.size > 1) return false
        }
        val offered = (question["options"] as? JsonArray).orEmpty().mapNotNullTo(mutableSetOf()) {
            ((it as? JsonObject)?.get("label") as? JsonPrimitive)?.contentOrNull
        }
        answer.selected.all { it in offered }
    }
}

private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
