package com.labteto.dshmobile.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import com.labteto.dshmobile.ui.theme.DshTheme

/**
 * Compact h24 chip: a badge at rest, a trigger when it takes an [onClick].
 *
 * The resting fill is `bgModulePlatform` rather than the harness's `bgLayer2`, and that is a
 * deliberate divergence from a faithful port. In the harness's light theme `bg-base` and all three
 * `bg-layer` rungs are the same pure white, so a pill at `bg-layer-2` on any of them is white on
 * white — the web gets away with it because `:hover` paints the chip the moment a pointer nears it.
 * A touchscreen has no pointer to near it with, so the chip has to be visible at rest or it is not
 * a chip at all: it is a run of grey text that happens to be tappable. The same reasoning already
 * put the model, preset and subagent triggers in the chat bar into pills, and put a permanent
 * chevron on [DisclosureRow].
 *
 * A tappable chip additionally takes a hairline, which is the only affordance separating it from a
 * badge once both have a fill. [selected] takes the accent wash the settings chips and the model
 * cards use — and which the harness itself uses for its own recommended badge. [warn] is unchanged.
 */
@Composable
fun DsPill(
    text: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    warn: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val colors = DsTheme.colors
    val shape = if (warn) DsShapes.pillFull else DsShapes.pill
    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()
    
    // Animate scale on press for better feedback
    val scale by animateFloatAsState(
        targetValue = if (isPressed) DsAnimations.Scale.pressed else DsAnimations.Scale.normal,
        animationSpec = DsAnimations.pressScale,
        label = "pillScale"
    )
    
    val background = when {
        warn -> colors.warnTertiary
        selected -> colors.accentTertiary
        else -> colors.bgModulePlatform
    }
    val contentColor = when {
        warn -> colors.warnLabel
        selected -> colors.accent
        else -> colors.labelSecondary
    }

    Surface(
        onClick = onClick ?: {},
        modifier = modifier
            .height(24.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            },
        enabled = onClick != null,
        shape = shape,
        color = background,
        contentColor = contentColor,
        // Outlined only when it is a trigger: with every chip now carrying a fill, the hairline is
        // what is left to say "this one does something" without a hover state to say it for you.
        border = if (onClick != null && !warn && !selected) {
            BorderStroke(1.dp, colors.borderL2)
        } else {
            null
        },
        interactionSource = interactionSource,
    ) {
        Box(
            modifier = Modifier.padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text,
                style = DsType.xsmall12,
                color = contentColor,
                maxLines = 1,
            )
        }
    }
}

@Preview(showBackground = true, widthDp = 360)
@Composable
private fun DsPillPreview() {
    DshTheme {
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DsPill("Badge")
            DsPill("Trigger", onClick = {})
            DsPill("Selected", selected = true, onClick = {})
            DsPill("Warn", warn = true)
        }
    }
}
