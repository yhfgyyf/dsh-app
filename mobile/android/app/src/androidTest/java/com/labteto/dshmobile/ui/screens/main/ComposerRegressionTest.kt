package com.labteto.dshmobile.ui.screens.main

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.labteto.dshmobile.R
import com.labteto.dshmobile.ui.theme.DshTheme
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.*
import java.io.ByteArrayOutputStream

class ComposerRegressionTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun photo(data: String) = PendingAttachment.Image("image/png", data, null, 12, 2, 2)

    @Test fun sessionSwitchUsesNewComposerAndAllImagesInOneSend() {
        val repository = ComposerRepository()
        val first = repository.get(ComposerKey("host", "first"))
        val second = repository.get(ComposerKey("host", "second"))
        first.text = "first"; first.attachments.add(photo("first"))
        second.text = "second"; second.attachments.addAll(listOf(photo("one"), photo("two")))
        var selected by mutableStateOf(first)
        val sent = mutableListOf<Pair<String, List<PendingAttachment>>>()
        compose.setContent {
            val target = selected
            DshTheme { Composer(target.text, { target.text = it }, target.attachments, {}, {}, null, null, {}, null, null,
                running = false, enabled = true, onOpenSheet = {}, onStop = {},
                onSend = { sent.add(target.key.sessionId to target.attachments.toList()) }, preparing = target.preparing) }
        }
        compose.runOnIdle { selected = second; second.preparing = true }
        compose.onNodeWithContentDescription(context.getString(R.string.chat_composer_send)).assertIsNotEnabled()
        compose.runOnIdle { second.preparing = false }
        compose.onNodeWithContentDescription(context.getString(R.string.chat_composer_send)).performClick()
        compose.runOnIdle {
            assertEquals(1, sent.size)
            assertEquals("second", sent.single().first)
            assertEquals(listOf("one", "two"), sent.single().second.filterIsInstance<PendingAttachment.Image>().map { it.base64 })
            assertEquals(1, first.attachments.size)
        }
    }

    /**
     * A running turn must still offer a way to send: that is the whole of issue #23. Send and stop
     * used to share one slot, so a running session showed only stop and the Queue/Steer modes were
     * unreachable from a touch keyboard.
     */
    @Test fun sendStaysAvailableBesideStopWhileATurnRuns() {
        var text by mutableStateOf("")
        var running by mutableStateOf(true)
        val sent = mutableListOf<String>()
        var stops = 0
        compose.setContent {
            DshTheme { Composer(text, { text = it }, emptyList(), {}, {}, null, null, {}, null, null,
                running = running, enabled = true, onOpenSheet = {}, onStop = { stops++ },
                onSend = { sent.add(it) }) }
        }
        val send = context.getString(R.string.chat_composer_send)
        val stop = context.getString(R.string.chat_composer_stop)

        // Both affordances are present mid-turn, and send waits for something to send.
        compose.onNodeWithContentDescription(stop).assertExists()
        compose.onNodeWithContentDescription(send).assertIsNotEnabled()

        compose.runOnIdle { text = "queue this" }
        compose.onNodeWithContentDescription(send).performClick()
        compose.runOnIdle { assertEquals(listOf("queue this"), sent) }

        // Stop still stops, and is the only one of the two that leaves when the turn ends.
        compose.onNodeWithContentDescription(stop).performClick()
        compose.runOnIdle { assertEquals(1, stops); running = false }
        compose.onNodeWithContentDescription(stop).assertDoesNotExist()
        compose.onNodeWithContentDescription(send).assertExists()
    }

    @Test fun rejectedSendRestoresOriginWithoutDroppingNewAttachments() {
        val repository = ComposerRepository()
        val original = repository.get(ComposerKey("host-a", "session"))
        val other = repository.get(ComposerKey("host-b", "session"))
        val submitted = listOf(photo("one"), photo("two"))
        original.attachments.add(photo("new"))
        original.restoreRejected("retry", submitted)
        original.restoreRejected("retry", submitted)
        assertEquals(listOf("one", "two", "new"), original.attachments.filterIsInstance<PendingAttachment.Image>().map { it.base64 })
        assertTrue(other.attachments.isEmpty())
        assertSame(original, repository.get(original.key))
    }

    @Test fun pickerUsesMultipleContentsAndCancellationIsEmpty() {
        val picker = ActivityResultContracts.GetMultipleContents()
        val intent = picker.createIntent(context, "image/*")
        assertEquals(Intent.ACTION_GET_CONTENT, intent.action)
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertEquals("image/*", intent.type)
        assertTrue(picker.parseResult(Activity.RESULT_CANCELED, null).isEmpty())
    }

    @Test fun corruptImagesFailAndValidPngHasBoundedThumbnail() {
        assertNull(decodePick(byteArrayOf(1, 2, 3)).preview)
        val bitmap = Bitmap.createBitmap(1000, 500, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out); out.toByteArray() }
        bitmap.recycle()
        val decoded = decodePick(bytes)
        assertEquals(1000, decoded.width)
        assertEquals(500, decoded.height)
        assertNotNull(decoded.preview)
        assertTrue(decoded.preview!!.width <= 448)
    }
}
