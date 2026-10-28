package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionItem
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionOption
import com.labteto.dshmobile.ui.theme.DshTheme
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * A long question must not starve the card of its own answer controls — issue #31.
 *
 * The card is a Column of header, scrolling body, and footer, capped at a fraction of the height it
 * is offered. Only the body is weighted, and a Compose Column measures its non-weighted children
 * first: the header takes what it asks for, the footer takes what is left, and the body divides the
 * remainder. The header's question text is unbounded when the card is expanded
 * (`maxLines = Int.MAX_VALUE`), so it asks for as many lines as it has.
 *
 * With room to spare that is fine. Once a keyboard shrinks the column and the cap is recomputed
 * against what remains, a question of a few lines can ask for the whole cap — and then the footer is
 * measured against nothing and the body gets nothing after it. The card renders as its prompt text
 * and no controls at all, which is what the report describes: "card truncated to prompt text only,
 * field + Skip/Submit gone".
 *
 * That is worse than the field being hard to reach. With the footer gone there is no Submit and no
 * Skip, so the card cannot be answered or dismissed from its own surface while the keyboard is up.
 *
 * Earlier attempts at this missed it because every one of them used a one-line question. The length
 * of the prompt is the variable that matters, so it is the variable this fixes in place.
 */
class QuestionCardStarvationTest {

    @get:Rule val compose = createComposeRule()

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val submit get() = context.getString(R.string.questions_submit)

    /**
     * A question as long as the ones a harness actually asks.
     *
     * Wrapped over several lines at phone width, which is the whole point: a one-line prompt leaves
     * room for everything below it and hides the defect entirely.
     */
    private val questions = listOf(
        AskUserQuestionItem(
            id = "approach",
            question = "The migration touches the session log format, the projection cache and " +
                "the two adapters that read them, so before I start I need to know which of these " +
                "you would rather I optimise for: keeping the existing on-disk layout readable by " +
                "the current release, or a clean break that lets the new reader drop its " +
                "compatibility path entirely?",
            options = listOf(
                AskUserQuestionOption("Keep the layout readable"),
                AskUserQuestionOption("Clean break"),
            ),
        ),
    )

    private fun fieldBounds(): Rect =
        compose.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot

    private fun submitBounds(): Rect =
        compose.onNodeWithText(submit).fetchSemanticsNode().boundsInRoot

    /**
     * The height of the card's scrolling body.
     *
     * This is the number the defect destroys. The body is the only weighted child, so it is measured
     * last and gets whatever the header and footer did not take: when an unbounded question in the
     * header asks for the whole cap, the body is measured against nothing and collapses to zero. A
     * zero-height body has no field, no options and nothing to scroll, which is the "field gone"
     * half of the report.
     *
     * Asserting on the field's own bounds instead does not work in either direction. A field below
     * the fold of a *working* scroll reports `Rect.Zero` exactly as a starved one does, and trying
     * to scroll to it when the viewport is zero does not fail, it hangs.
     */
    private fun bodyHeight(): Float =
        compose.onNode(hasScrollAction()).fetchSemanticsNode().boundsInRoot.height

    @Test
    fun aLongQuestionLeavesRoomForTheAnswerControls() {
        var height by mutableStateOf(ROOMY_HEIGHT)
        compose.setContent {
            DshTheme {
                Box(Modifier.height(height)) {
                    QuestionsPanel(
                        requestKey = "evt-1",
                        questions = questions,
                        onSubmit = { _: AskUserQuestionAnswer -> null },
                        onDismiss = { null },
                    )
                }
            }
        }

        // With the keyboard down everything is on screen, which is the state people report as fine.
        assertNotEquals("Submit should start in view", Rect.Zero, submitBounds())
        assertNotEquals("the field should start in view", Rect.Zero, fieldBounds())

        // The keyboard opens and the column has this much left for the card.
        height = CRAMPED_HEIGHT
        compose.waitForIdle()

        // Submit and Skip are the card's only way to resolve the request, and they sit outside the
        // scrolling body so they cannot be scrolled away from.
        assertNotEquals(
            "the answer controls were starved out of the card (#31)",
            Rect.Zero,
            submitBounds(),
        )

        // And the body has to survive too, or there is no field to type into and nothing to scroll.
        assertTrue(
            "the question text starved the card's body to nothing, so the answer field does not " +
                "exist to be scrolled to (#31)",
            bodyHeight() > 0f,
        )
    }

    private companion object {
        /** A phone's chat column with no keyboard up. */
        val ROOMY_HEIGHT: Dp = 700.dp

        /** What is left once a keyboard takes roughly half the screen. */
        val CRAMPED_HEIGHT: Dp = 260.dp
    }
}
