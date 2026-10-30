package com.labteto.dshmobile.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionItem
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionOption
import com.labteto.dshmobile.ui.theme.DshTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * How an `ask_user_question` card is allowed to end — issue #27.
 *
 * The card's submit latch closes and stays closed on success, because the request behind it is
 * over and the store takes the whole card away. That was already the design; what was missing was
 * anything to do the taking. The harness settles a waterfall by dropping the answering client's
 * delivery *first* and then cancelling the rest, so the client that answered is the one client
 * never told the request resolved, and a card that waited for that frame waited forever: answered,
 * dismissed and skipped cards alike froze on "Submitting…" until the app was force-stopped.
 *
 * So both halves are pinned here. A settled answer leaves the card latched — it must not re-arm
 * and invite a second submit against a request that is gone — and the panel disappears because its
 * caller stops drawing it. A refusal does the opposite: the harness's wait is still open and this
 * card is the only thing that can still answer it, so it has to come back usable and say why.
 */
class QuestionCardExitTest {

    @get:Rule val compose = createComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val submit get() = context.getString(R.string.questions_submit)
    private val submitting get() = context.getString(R.string.questions_submitting)

    private val questions = listOf(
        AskUserQuestionItem(
            id = "approach",
            question = "Which approach?",
            options = listOf(AskUserQuestionOption("Rewrite"), AskUserQuestionOption("Patch")),
        ),
    )

    /**
     * Draws the card the way ChatScreen does: while the request is held, and not after.
     *
     * @return the gate the pending answer completes with — null for taken, a message for refused.
     */
    private fun showCard(
        onSettled: () -> Unit = {},
        submitted: MutableList<AskUserQuestionAnswer> = mutableListOf(),
    ): CompletableDeferred<String?> {
        val gate = CompletableDeferred<String?>()
        compose.setContent {
            var held by remember { mutableStateOf(true) }
            DshTheme {
                if (held) {
                    QuestionsPanel(
                        requestKey = "evt-1",
                        questions = questions,
                        onSubmit = { answer ->
                            submitted.add(answer)
                            gate.await().also { refusal ->
                                // What the store does on a settled request, and only then.
                                if (refusal == null) {
                                    held = false
                                    onSettled()
                                }
                            }
                        },
                        onDismiss = { gate.await() },
                    )
                }
            }
        }
        return gate
    }

    @Test
    fun aTakenAnswerTakesTheCardWithIt() {
        val submitted = mutableListOf<AskUserQuestionAnswer>()
        var settled = 0
        val gate = showCard(onSettled = { settled++ }, submitted = submitted)

        compose.onNodeWithText("Rewrite").performClick()
        compose.onNodeWithText(submit).performClick()

        // In flight: the latch is closed and the card says so.
        compose.onNodeWithText(submitting).assertIsNotEnabled()

        gate.complete(null)
        compose.waitForIdle()

        // Gone, and gone exactly once — nothing re-armed for a second submit against a request
        // the harness has already settled.
        compose.onNodeWithText(submitting).assertDoesNotExist()
        compose.onNodeWithText(submit).assertDoesNotExist()
        compose.onNodeWithText("Which approach?").assertDoesNotExist()
        assertEquals(1, settled)
        assertEquals(1, submitted.size)
        assertEquals(listOf("Rewrite"), submitted.single().answers.single().selected)
    }

    @Test
    fun aRefusedAnswerHandsTheCardBackWithTheReason() {
        val gate = showCard()

        compose.onNodeWithText("Rewrite").performClick()
        compose.onNodeWithText(submit).performClick()
        compose.onNodeWithText(submitting).assertIsNotEnabled()

        gate.complete("The harness would not accept that answer (bad-response).")
        compose.waitForIdle()

        // The wait is still open, so the card is still the way to answer it: usable, with the
        // refusal named rather than swallowed.
        compose.onNodeWithText("The harness would not accept that answer (bad-response).").assertExists()
        compose.onNodeWithText(submit).assertIsEnabled()
        compose.onNodeWithText("Which approach?").assertExists()
    }
}
