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
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionItem
import com.labteto.dshmobile.ui.theme.DshTheme
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test

/**
 * The free-text answer stays reachable when the space the card is offered shrinks.
 *
 * An opening keyboard does exactly one thing to this card: the chat column consumes the IME inset,
 * and the card's height cap is recomputed against what is left. So driving that height directly is
 * the same mechanism, without an IME and without a device-specific keyboard. The card caps itself
 * at a fraction of what it is offered and scrolls its body inside that cap, and the field is the
 * last thing in the body — the furthest from view and the first to be clipped if the shrink is
 * mishandled.
 *
 * This was written while investigating #31 (a report that the keyboard covers this field on
 * Android 16 / Samsung / SwiftKey) and it **does not reproduce that report** — it passed before any
 * change, and a probe with a real keyboard on API 30 measured the field sitting well above the
 * keyboard with the column correctly shortened. It is kept as a regression guard for the behaviour
 * that *was* verified, not as coverage of #31, which remains open.
 *
 * One note for anyone extending it: `assertIsDisplayed()` is useless here, because it passes for a
 * clipped node. The signal that means "clipped out of view" is `boundsInRoot == Rect.Zero`, since
 * Compose clips a node's reported bounds to its parents. That is what is asserted below, and
 * mistaking the one for the other cost several wrong diagnoses.
 */
class QuestionFieldVisibilityTest {

    @get:Rule val compose = createComposeRule()

    /**
     * A long detail body and no options: the free-text case the report describes.
     *
     * The prose is what pushes the field past the bottom of the card's viewport, which is the
     * starting position a person meets before they scroll down to type.
     */
    private val questions = listOf(
        AskUserQuestionItem(
            id = "approach",
            question = "Which approach should we take for the migration?",
            detail = (1..8).joinToString(" ") {
                "Sentence $it of a detail body long enough to fill the card's scrollable area."
            },
        ),
    )

    private fun fieldBounds(): Rect =
        compose.onNode(hasSetTextAction()).fetchSemanticsNode().boundsInRoot

    @Test
    fun theFreeTextAnswerStaysInViewWhenTheCardIsShrunk() {
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

        // What a person does: scroll down to the field, then tap it.
        compose.onNode(hasSetTextAction()).performScrollTo()
        compose.onNode(hasSetTextAction()).requestFocus()
        compose.waitForIdle()
        assertNotEquals("the field should be in view before the keyboard opens", Rect.Zero, fieldBounds())

        // The keyboard opens: the column consumes its inset and the card is offered this much less.
        height = CRAMPED_HEIGHT
        compose.waitForIdle()

        assertNotEquals(
            "the field was clipped out of view once the card shrank",
            Rect.Zero,
            fieldBounds(),
        )
    }

    private companion object {
        /** A phone's chat column with no keyboard up. */
        val ROOMY_HEIGHT: Dp = 700.dp

        /** What is left once a keyboard takes roughly half the screen. */
        val CRAMPED_HEIGHT: Dp = 260.dp
    }
}
