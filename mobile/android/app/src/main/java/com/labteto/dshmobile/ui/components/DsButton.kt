package com.labteto.dshmobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import com.labteto.dshmobile.ui.theme.DshTheme

/** Button variants mirroring the harness primary/info/ghost/outline/danger palette. */
enum class DsButtonVariant { Primary, Info, Ghost, Outline, Danger }

/** Button sizes: [Normal] is h36 r18, [Small] is h28 r14. */
enum class DsButtonSize { Normal, Small }

/** Ink/ghost/outline button in the DeepSeek Harness style. */
@Composable
fun DsButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    variant: DsButtonVariant = DsButtonVariant.Primary,
    size: DsButtonSize = DsButtonSize.Normal,
    icon: ImageVector? = null,
) {
    val colors = DsTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    
    // Animate scale on press for tactile feedback
    val scale by animateFloatAsState(
        targetValue = if (pressed && enabled) DsAnimations.Scale.pressed else DsAnimations.Scale.normal,
        animationSpec = DsAnimations.pressScale,
        label = "buttonScale"
    )
    
    val (fill, content) = when (variant) {
        DsButtonVariant.Primary -> colors.brandPrimary to colors.onBrandPrimary
        DsButtonVariant.Info -> colors.buttonInfoFill to colors.onAccent
        DsButtonVariant.Ghost -> Color.Transparent to colors.labelPrimary
        DsButtonVariant.Outline -> Color.Transparent to colors.labelPrimary
        DsButtonVariant.Danger -> colors.error to Color.White
    }
    val background = when {
        !enabled -> when (variant) {
            DsButtonVariant.Ghost, DsButtonVariant.Outline -> colors.bgLayer2
            else -> fill.copy(alpha = 0.4f)
        }
        hovered -> when (variant) {
            DsButtonVariant.Primary -> colors.buttonPrimaryHover
            DsButtonVariant.Info -> colors.buttonInfoHover
            DsButtonVariant.Ghost, DsButtonVariant.Outline -> colors.hover
            DsButtonVariant.Danger -> lerp(colors.error, Color.Black, 0.15f)
        }
        else -> fill
    }
    val contentColor = if (enabled) content else content.copy(alpha = 0.5f)
    val normal = size == DsButtonSize.Normal
    Surface(
        onClick = onClick,
        modifier = modifier
            .height(if (normal) 36.dp else 28.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
        enabled = enabled,
        shape = if (normal) DsShapes.buttonCapsule else DsShapes.buttonSmall,
        color = background,
        contentColor = contentColor,
        border = if (variant == DsButtonVariant.Outline) BorderStroke(1.dp, colors.borderL2) else null,
        interactionSource = interaction,
    ) {
        Row(
            // Height, not size. `fillMaxSize` here made the *content* claim the whole width it was
            // offered, which pushed the button itself out to full width whatever the caller asked
            // for — so any row of buttons rendered the first one and squeezed the rest to nothing.
            // A button that wants to span its parent says so through `modifier`, as several do.
            modifier = Modifier.fillMaxHeight().padding(horizontal = if (normal) 16.dp else 12.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) {
                Icon(
                    icon,
                    contentDescription = null,
                    modifier = Modifier.size(if (normal) 16.dp else 14.dp),
                    tint = contentColor,
                )
                if (text.isNotEmpty()) Spacer(Modifier.width(6.dp))
            }
            if (text.isNotEmpty()) {
                Text(
                    text,
                    style = if (normal) DsType.std14Strong else DsType.small13Strong,
                    color = contentColor,
                    maxLines = 1,
                )
            }
        }
    }
}

@Preview(showBackground = true, widthDp = 360)
@Composable
private fun DsButtonPreview() {
    DshTheme {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            DsButton("Primary", {}, icon = Icons.Filled.Add)
            DsButton("Info", {}, variant = DsButtonVariant.Info)
            DsButton("Ghost", {}, variant = DsButtonVariant.Ghost)
            DsButton("Outline", {}, variant = DsButtonVariant.Outline)
            DsButton("Danger", {}, variant = DsButtonVariant.Danger)
            DsButton("Disabled", {}, enabled = false)
            DsButton("Small", {}, size = DsButtonSize.Small)
        }
    }
}
