package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.FULL_ACCESS_PRESET
import com.labteto.dshmobile.core.wire.dto.PermissionSelect
import com.labteto.dshmobile.core.wire.dto.displayPermissionPreset
import com.labteto.dshmobile.ui.components.DsBottomSheet
import com.labteto.dshmobile.ui.components.DsButton
import com.labteto.dshmobile.ui.components.DsButtonVariant
import com.labteto.dshmobile.ui.components.DsDialog
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

/** The permission-preset picker. `custom` is a derived state, so it is never offered as a target. */
@Composable
internal fun PermissionMenu(
    select: PermissionSelect,
    current: String,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val colors = DsTheme.colors
    DsBottomSheet(
        title = stringResource(R.string.permission_preset),
        onDismiss = onDismiss,
    ) {
        select.selectable.forEach { option ->
            val selected = option.value == current
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onPick(option.value) }
                    .padding(vertical = DsSpacing.small),
                verticalAlignment = Alignment.Top,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        displayPermissionPreset(option.value, option.name),
                        style = DsType.std14Strong,
                        color = if (selected) colors.accent else colors.labelPrimary,
                    )
                    val description = option.description
                        ?: if (option.value == FULL_ACCESS_PRESET) {
                            stringResource(R.string.permission_confirm_body)
                        } else {
                            null
                        }
                    if (description != null) {
                        Text(description, style = DsType.caption11, color = colors.labelTertiary)
                    }
                }
                if (selected) {
                    Spacer(Modifier.width(8.dp))
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        tint = colors.accent,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
        if (select.currentValue !in select.selectable.map { it.value }) {
            Text(
                stringResource(R.string.permission_custom_hint),
                style = DsType.caption11,
                color = colors.warnLabel,
            )
        }
    }
}

/**
 * Full access removes the approval prompt for every subsequent tool call, so it takes a deliberate
 * acknowledgement rather than a single tap — the same gate the desktop client puts on it.
 */
@Composable
internal fun FullAccessConfirmDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val colors = DsTheme.colors
    var acknowledged by remember { mutableStateOf(false) }
    DsDialog(title = stringResource(R.string.permission_confirm_title), onDismiss = onDismiss) {
        Text(
            stringResource(R.string.permission_confirm_body),
            style = DsType.std14,
            color = colors.labelSecondary,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { acknowledged = !acknowledged },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = acknowledged, onCheckedChange = { acknowledged = it })
            Text(
                stringResource(R.string.permission_confirm_ack),
                style = DsType.small13,
                color = colors.labelPrimary,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(DsSpacing.small)) {
            DsButton(
                text = stringResource(R.string.common_ok),
                onClick = onConfirm,
                variant = DsButtonVariant.Danger,
                enabled = acknowledged,
            )
            DsButton(
                text = stringResource(R.string.common_cancel),
                onClick = onDismiss,
                variant = DsButtonVariant.Ghost,
            )
        }
    }
}
