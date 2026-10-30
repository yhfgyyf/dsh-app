package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.labteto.dshmobile.R
import com.labteto.dshmobile.ui.media.AttachmentImageState
import com.labteto.dshmobile.ui.media.aspectRatioOf
import com.labteto.dshmobile.ui.media.rememberAttachmentCache
import com.labteto.dshmobile.ui.media.rememberAttachmentImage
import com.labteto.dshmobile.ui.rememberSessionStore
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

/**
 * One raster attachment in the transcript: a placeholder holding the reference's own aspect ratio
 * while it loads, then the decoded image, tappable for a full-screen view.
 *
 * Reserving the right box up front matters more here than usual — the transcript auto-scrolls to
 * the bottom, and an image that grows after layout would drag the view out from under the reader.
 */
@Composable
fun AttachmentImage(
    attachmentId: String,
    intrinsicWidth: Int,
    intrinsicHeight: Int,
    modifier: Modifier = Modifier,
    maxHeight: Int = 240,
    contentDescription: String? = null,
) {
    val colors = DsTheme.colors
    val store = rememberSessionStore()
    val cache = rememberAttachmentCache()
    val density = LocalDensity.current
    val screenWidthDp = LocalConfiguration.current.screenWidthDp
    // Decode for the widest the transcript can ever show it, not for the source resolution.
    val targetWidthPx = remember(screenWidthDp) { with(density) { screenWidthDp.dp.roundToPx() } }
    val state by rememberAttachmentImage(
        attachmentId = attachmentId,
        intrinsicWidth = intrinsicWidth,
        intrinsicHeight = intrinsicHeight,
        targetWidthPx = targetWidthPx,
        store = store,
        cache = cache,
    )
    var zoomed by remember(attachmentId) { mutableStateOf(false) }
    val ratio = remember(intrinsicWidth, intrinsicHeight) {
        aspectRatioOf(intrinsicWidth, intrinsicHeight)
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = maxHeight.dp)
            .clip(DsShapes.block)
            .background(colors.bgModulePlatform),
        contentAlignment = Alignment.Center,
    ) {
        when (val current = state) {
            AttachmentImageState.Loading -> Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(ratio)
                    .skeleton(base = colors.bgModulePlatform, highlight = colors.hover),
            )
            AttachmentImageState.Failed -> Text(
                stringResource(R.string.chat_image_failed),
                style = DsType.caption11,
                color = colors.labelTertiary,
                modifier = Modifier.padding(16.dp),
            )
            is AttachmentImageState.Ready -> Image(
                bitmap = current.image,
                contentDescription = contentDescription ?: stringResource(R.string.chat_image_open),
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { zoomed = true },
            )
        }
    }

    val ready = state as? AttachmentImageState.Ready
    if (zoomed && ready != null) {
        Dialog(
            onDismissRequest = { zoomed = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(colors.overlayMask)
                    .clickable { zoomed = false },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bitmap = ready.image,
                    contentDescription = contentDescription,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxWidth().widthIn(max = 1200.dp),
                )
            }
        }
    }
}
