package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import com.labteto.dshmobile.ui.theme.DshTheme

/** Section title row with an optional right-aligned accent action. */
@Composable
fun SectionHeader(
    title: String,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val colors = DsTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            title,
            style = DsType.std14Strong,
            color = colors.labelSecondary,
            modifier = Modifier.weight(1f),
        )
        if (action != null) {
            Text(
                action,
                style = DsType.caption11Strong,
                color = colors.accent,
                modifier = if (onAction != null) {
                    Modifier.clickable(onClick = onAction).padding(4.dp)
                } else {
                    Modifier.padding(4.dp)
                },
            )
        }
    }
}

@Preview(showBackground = true, widthDp = 360)
@Composable
private fun SectionHeaderPreview() {
    DshTheme {
        SectionHeader(
            title = "Tool calls",
            action = "Clear",
            onAction = {},
        )
    }
}
