package com.labteto.dshmobile.ui.screens.main

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.theme.DsAnimations
import kotlinx.coroutines.launch

/**
 * Discord-style shell:
 *  - swipe right from the LEFT edge (or anywhere on the content) opens the chat-list drawer
 *    (ModalNavigationDrawer's built-in gesture; swipe left on the drawer
 *    content closes it, scrim tap and Back also work)
 *  - swipe left from the RIGHT edge opens the session Details panel
 *  - swipe right anywhere on the open Details panel closes it
 *
 * The details gesture detector only claims the drags it owns (leftward from the right edge
 * band, or any drag on the details area while it is open) and leaves every other horizontal
 * drag unconsumed. ModalNavigationDrawer puts an anchoredDraggable(Horizontal) on the whole
 * surface, so an always-consuming detector here would starve the drawer's open gesture.
 * Horizontal edge drags are axis-orthogonal to the chat list's vertical scroll, so the two
 * never conflict.
 */
@Composable
fun MainScreen(onOpenSettings: () -> Unit) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var detailsOpen by remember { mutableStateOf(false) }
    val detailsWidth = 300.dp

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ChatListDrawer(
                onClose = { scope.launch { drawerState.close() } },
                onOpenSettings = onOpenSettings,
            )
        },
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(detailsOpen) {
                    val width = size.width.toFloat()
                    val edgeBandPx = 28.dp.toPx()
                    val detailsAreaPx = detailsWidth.toPx() * 0.9f
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        val startX = down.position.x
                        // Claim only gestures this screen handles: leftward drags starting in
                        // the right edge band open details; drags starting on the open details
                        // panel close it. Everything else (notably left-to-right swipes) must
                        // stay unconsumed for the drawer's built-in open gesture.
                        val owned = if (!detailsOpen) {
                            startX >= width - edgeBandPx
                        } else {
                            startX <= detailsAreaPx
                        }
                        if (!owned) return@awaitEachGesture

                        var claimed = false
                        awaitHorizontalTouchSlopOrCancellation(down.id) { change, overSlop ->
                            // While closed, only a leftward drag belongs to this screen; a
                            // rightward drag from the edge is the drawer's to open with.
                            claimed = detailsOpen || overSlop < 0f
                            if (claimed) change.consume()
                        } ?: return@awaitEachGesture
                        if (!claimed) return@awaitEachGesture

                        var totalX = 0f
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (change.changedToUpIgnoreConsumed()) break
                            // A deeper scrollable claimed the drag; let it keep it.
                            if (change.isConsumed) break
                            totalX += change.positionChange().x
                            change.consume()
                            val threshold = width * 0.12f
                            if (!detailsOpen && totalX <= -threshold) {
                                detailsOpen = true
                                break
                            }
                            if (detailsOpen && totalX >= threshold) {
                                detailsOpen = false
                                break
                            }
                        }
                    }
                },
        ) {
            ChatScreen(
                onOpenDetails = { detailsOpen = true },
                onOpenDrawer = { scope.launch { drawerState.open() } },
                detailsOpen = detailsOpen,
            )

            AnimatedVisibility(
                visible = detailsOpen,
                // Explicit spec: the platform default runs 300ms, which lags behind the drag the
                // panel is usually opened with.
                enter = slideInHorizontally(DsAnimations.panelSlide) { it },
                exit = slideOutHorizontally(DsAnimations.panelSlide) { it },
                modifier = Modifier.align(Alignment.CenterEnd),
            ) {
                DetailsPanel(
                    onClose = { detailsOpen = false },
                    modifier = Modifier.width(detailsWidth),
                )
            }
        }
    }
}
