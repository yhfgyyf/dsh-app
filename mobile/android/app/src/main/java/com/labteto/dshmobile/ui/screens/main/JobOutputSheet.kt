package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.JobFollowFrame
import com.labteto.dshmobile.core.wire.dto.JobStatus
import com.labteto.dshmobile.core.wire.dto.JobView
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.DsBottomSheet
import com.labteto.dshmobile.ui.components.DsIconButton
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Most characters of output the sheet keeps. A job's ring is the host's to retain; a phone showing
 * a long build log only needs its tail, and an unbounded string grows with every frame.
 */
private const val MAX_OUTPUT_CHARS = 256 * 1024

/**
 * One background job's output, followed live (harness 0.1.7's `job/follow`).
 *
 * The stream starts at the oldest byte the host still holds, delivers output in batches, and ends
 * with the job's settled state once it has finished and drained. Output the host already evicted,
 * or that this sheet trims to stay bounded, is marked rather than silently missing.
 */
@Composable
internal fun JobOutputSheet(job: JobView, store: SessionStore, canStop: Boolean, onDismiss: () -> Unit) {
    val colors = DsTheme.colors
    val scope = rememberCoroutineScope()
    var current by remember(job.id) { mutableStateOf(job) }
    var output by remember(job.id) { mutableStateOf("") }
    var dropped by remember(job.id) { mutableStateOf(false) }
    var ended by remember(job.id) { mutableStateOf(false) }

    LaunchedEffect(job.id) {
        try {
            store.followJob(job.id).collect { frame ->
                when (frame) {
                    is JobFollowFrame.Opened -> {
                        current = frame.job
                        // The stream begins at the oldest retained byte; past zero, the head is gone.
                        if (frame.from > 0) dropped = true
                    }
                    is JobFollowFrame.Output -> {
                        if (frame.lossy || frame.chunks.any { it.gapBefore }) dropped = true
                        val next = output + frame.chunks.joinToString("") { it.text }
                        if (next.length > MAX_OUTPUT_CHARS) dropped = true
                        output = next.takeLast(MAX_OUTPUT_CHARS)
                    }
                    is JobFollowFrame.Status -> current = frame.job
                    is JobFollowFrame.Unknown -> Unit
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The rows still show the job's state; losing the live feed is not worth a banner.
        }
        ended = true
    }

    val scroll = rememberScrollState()
    // Follow the tail the way a terminal does, as the output grows.
    LaunchedEffect(output) { scroll.scrollTo(scroll.maxValue) }

    val running = current.status == JobStatus.RUNNING
    DsBottomSheet(
        title = current.label,
        subtitle = listOfNotNull(current.kind, jobStatusLabel(current.status), current.progress ?: current.detail)
            .joinToString(" · "),
        onDismiss = onDismiss,
        trailing = if (canStop && running) {
            {
                DsIconButton(
                    icon = Icons.Filled.Stop,
                    contentDescription = stringResource(R.string.jobs_stop),
                    onClick = { scope.launch { store.killJob(current.id) } },
                    tint = colors.error,
                )
            }
        } else {
            null
        },
    ) {
        if (dropped) {
            Text(stringResource(R.string.jobs_output_dropped), style = DsType.caption11, color = colors.labelCaption)
        }
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 420.dp)
                .background(colors.bgModulePlatform, DsShapes.block)
                .verticalScroll(scroll)
                .horizontalScroll(rememberScrollState())
                .padding(DsSpacing.small),
        ) {
            SelectionContainer {
                Text(
                    output.ifEmpty { if (ended) "" else stringResource(R.string.jobs_output_empty) },
                    style = DsType.caption11,
                    fontFamily = FontFamily.Monospace,
                    color = colors.labelSecondary,
                )
            }
        }
    }
}
