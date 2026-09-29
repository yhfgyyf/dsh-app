package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

/**
 * A labelled on/off row: name (with optional [hint]) on the left, a switch on the right.
 *
 * The whole row is the tap target, not just the switch — a 32dp thumb at the far edge of a phone is
 * a poor thing to have to hit, and the label is what people aim at anyway.
 *
 * Shared rather than settings-local because a toggle should read the same wherever it appears:
 * anything that states its own state and flips on tap belongs here, not in a bespoke card.
 */
@Composable
fun ToggleRow(label: String, checked: Boolean, hint: String? = null, onChange: () -> Unit) {
    val colors = DsTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(DsShapes.row)
            .clickable(onClick = onChange)
            .padding(vertical = DsSpacing.small),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = DsType.std14, color = colors.labelSecondary)
            if (hint != null) {
                Text(hint, style = DsType.caption11, color = colors.labelCaption)
            }
        }
        Switch(checked = checked, onCheckedChange = { onChange() })
    }
}
