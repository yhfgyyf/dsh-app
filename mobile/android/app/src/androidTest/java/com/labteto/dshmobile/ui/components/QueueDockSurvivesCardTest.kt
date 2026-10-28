package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionAnswer
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionItem
import com.labteto.dshmobile.core.wire.dto.AskUserQuestionOption
import com.labteto.dshmobile.ui.theme.DshTheme
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * An open question card must not push the queue dock off the screen — issue #33.
 *
 * A message sent from the composer while the agent is mid-turn is queued rather than lost, and the
 * dock above the card is the only place it appears: it is not in the transcript, because a queued
 * message is not a durable event yet. So if the card can crowd the dock out, the send looks dead,
 * and what people do about a send that looks dead is send it again. The duplicates that arrive when
 * the queue releases are the real cost of this.
 *
 * The dock and the card are both unweighted children of the chat column, with the dock first, so
 * the dock is measured before the card and the card is capped at a fraction of what is left. That
 * ordering is the whole guarantee, and it is worth pinning because it is invisible in the source:
 * moving `QueueDock` below the card, or giving the card a weight, would silently reverse it.
 *
 * `QueueDock` itself needs a `SessionStore`, which is more machinery than this question deserves, so
 * it stands in as a fixed-height box. The card is real, and the card is the part that does the
 * crowding.
 */
class QueueDockSurvivesCardTest {

    @get:Rule val compose = createComposeRule()

    /** Long enough that the card wants more room than a keyboard leaves it. */
    private val questions = listOf(
        AskUserQuestionItem(
            id = "approach",
            question = "The migration touches the session log format, the projection cache and " +
                "the two adapters that read them, so which would you rather I optimise for?",
            options = listOf(
                AskUserQuestionOption("Keep the layout readable"),
                AskUserQuestionOption("Clean break"),
            ),
        ),
    )

    private fun bounds(tag: String): Rect =
        compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot

    @Test
    fun anOpenCardLeavesTheQueueDockOnScreen() {
        compose.setContent {
            DshTheme {
                // The chat column as a keyboard leaves it: chrome, a transcript that gives up its
                // space, the dock, the card, and the composer that has to stay reachable.
                Column(Modifier.height(CRAMPED_COLUMN).fillMaxWidth().testTag("column")) {
                    Box(Modifier.testTag("chrome").fillMaxWidth().height(56.dp))
                    Box(Modifier.testTag("transcript").fillMaxWidth().weight(1f))
                    Box(Modifier.testTag("dock").fillMaxWidth().height(DOCK_HEIGHT))
                    QuestionsPanel(
                        requestKey = "evt-1",
                        questions = questions,
                        onSubmit = { _: AskUserQuestionAnswer -> null },
                        onDismiss = { null },
                    )
                    Box(Modifier.testTag("composer").fillMaxWidth().height(80.dp))
                }
            }
        }
        compose.waitForIdle()

        val column = bounds("column")
        val dock = bounds("dock")
        val composer = bounds("composer")

        assertNotEquals("the queue dock was squeezed out by the open card", Rect.Zero, dock)
        assertTrue(
            "the queue dock was pushed past the bottom of the column by the open card (#33)",
            dock.bottom <= column.bottom,
        )
        // The composer is the other thing that must not be crowded out: it is where the next
        // message is typed, and it sits below the card.
        assertTrue(
            "the composer was pushed past the bottom of the column by the open card",
            composer.bottom <= column.bottom,
        )
    }

    private companion object {
        /** A phone's chat column with a keyboard taking roughly half the screen. */
        val CRAMPED_COLUMN: Dp = 380.dp

        /** One queued row and its disclosure header. */
        val DOCK_HEIGHT: Dp = 56.dp
    }
}
