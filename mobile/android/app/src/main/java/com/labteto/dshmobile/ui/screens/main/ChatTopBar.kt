package com.labteto.dshmobile.ui.screens.main

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.SessionModelsValue
import com.labteto.dshmobile.ui.components.DsIconButton
import com.labteto.dshmobile.ui.components.DsSegment
import com.labteto.dshmobile.ui.components.DsSegmented
import com.labteto.dshmobile.ui.components.FeatherIcons
import com.labteto.dshmobile.ui.components.StateDot
import com.labteto.dshmobile.ui.components.StateDotState
import com.labteto.dshmobile.ui.components.skeleton
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

/** The two views of a session the harness offers. */
internal enum class ChatTab { Chat, Trajectory }

/**
 * The session chrome: a two-row bar plus the Chat / Trajectory tabs.
 *
 * Row one carries the controls that belong to the *connection* — the drawer, the model, the live
 * status. Row two carries the ones that belong to the *session* — its title, its agent preset, its
 * subagents. Splitting them is what makes room for the model selector on the left without eliding
 * the session title down to nothing on a phone.
 *
 * The title and the chips share row two rather than stacking, and the row disappears entirely when
 * it would be empty: four stacked rows of chrome over a white page ate a third of a phone screen
 * before the first message, and the chip row kept its padding even with no chips to pad.
 */
@Composable
internal fun ChatTopBar(
    title: String,
    running: Boolean,
    models: SessionModelsValue?,
    agentPresetLabel: String?,
    subagentCount: Int,
    detailsOpen: Boolean,
    tab: ChatTab,
    onOpenDrawer: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenPresets: () -> Unit,
    onOpenSubagents: () -> Unit,
    onOpenDetails: () -> Unit,
    onTabChange: (ChatTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DsTheme.colors
    Column(modifier.fillMaxWidth().background(colors.bgBase)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .padding(horizontal = DsSpacing.tiny),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            DsIconButton(
                icon = FeatherIcons.Menu,
                contentDescription = stringResource(R.string.chatlist_open),
                onClick = onOpenDrawer,
                tint = colors.labelSecondary,
                iconSize = 18.dp,
            )
            ModelChip(models = models, onClick = onOpenModels, modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            StateDot(if (running) StateDotState.Running else StateDotState.Idle)
            if (!detailsOpen) {
                DsIconButton(
                    icon = FeatherIcons.Info,
                    contentDescription = stringResource(R.string.chat_details_title),
                    onClick = onOpenDetails,
                    tint = colors.labelTertiary,
                    iconSize = 18.dp,
                )
            }
        }

        val hasChips = agentPresetLabel != null || subagentCount > 0
        if (title.isNotBlank() || hasChips) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = DsSpacing.medium, vertical = DsSpacing.tiny),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(DsSpacing.tiny),
            ) {
                Text(
                    title,
                    style = DsType.std14Strong,
                    color = colors.labelPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (agentPresetLabel != null) {
                    MetaChip(
                        icon = Icons.Outlined.Dashboard,
                        label = agentPresetLabel,
                        onClick = onOpenPresets,
                    )
                }
                if (subagentCount > 0) {
                    MetaChip(
                        icon = Icons.Outlined.Groups,
                        label = "$subagentCount",
                        onClick = onOpenSubagents,
                    )
                }
            }
        }

        ChatTabRow(tab = tab, onTabChange = onTabChange)
    }
}

/**
 * The model chip: display names, not wire ids.
 *
 * `session.models` returns `deepseek-official / deepseek-v4-pro / max`, which is not what anyone
 * calls it — the catalog's own names resolve that to `DeepSeek-V4-Pro Max`.
 *
 * Drawn as a filled pill rather than the harness's transparent trigger. That is not a style
 * preference: on the web the affordance is the hover state, and a touch screen has no hover, so
 * bare text over the transcript gave no sign the model was switchable at all.
 */
@Composable
private fun ModelChip(
    models: SessionModelsValue?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DsTheme.colors
    if (models == null) {
        Box(
            modifier
                .padding(horizontal = DsSpacing.small)
                .width(120.dp)
                .height(14.dp)
                .skeleton(colors.bgLayer2, colors.hover),
        )
        return
    }
    val current = models.current
    val group = models.groups.firstOrNull { it.id == current.provider }
    val model = group?.models?.firstOrNull { it.id == current.model }
    val effort = model?.reasoning?.efforts?.firstOrNull { it.id == current.reasoningEffort }
    val modelLabel = model?.name ?: current.model

    Row(
        modifier = modifier
            .widthIn(max = 240.dp)
            .heightIn(min = 28.dp)
            .clip(DsShapes.pillFull)
            .background(colors.hoverSolid)
            .border(1.dp, colors.borderL2, DsShapes.pillFull)
            .clickable(onClick = onClick)
            .padding(horizontal = DsSpacing.compact, vertical = DsSpacing.tiny),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(DsSpacing.tiny),
    ) {
        if (!models.routable) {
            StateDot(StateDotState.Warning, size = 6.dp)
        }
        Text(
            modelLabel,
            style = DsType.std14Strong,
            color = colors.labelPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        effort?.let {
            Text(it.name, style = DsType.small13, color = colors.labelTertiary, maxLines = 1)
        }
        Icon(
            Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = colors.labelSecondary,
            modifier = Modifier.size(14.dp),
        )
    }
}

/** The preset and subagent chips. Same reasoning as [ModelChip]: a tap target has to look like one. */
@Composable
private fun MetaChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    val colors = DsTheme.colors
    Row(
        modifier = Modifier
            .heightIn(min = 28.dp)
            .clip(DsShapes.pillFull)
            .background(colors.hoverSolid)
            .border(1.dp, colors.borderL2, DsShapes.pillFull)
            .clickable(onClick = onClick)
            .padding(horizontal = DsSpacing.compact, vertical = DsSpacing.tiny),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(DsSpacing.tiny),
    ) {
        Icon(icon, contentDescription = null, tint = colors.labelTertiary, modifier = Modifier.size(14.dp))
        Text(label, style = DsType.small13, color = colors.labelSecondary, maxLines = 1)
        Icon(
            Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = colors.labelSecondary,
            modifier = Modifier.size(12.dp),
        )
    }
}

/**
 * The tab strip, as a compact segmented control rather than underlined tabs.
 *
 * Two short labels sitting over a full-width underline read as a page heading and cost a row of
 * their own; a 28dp track wraps to the labels and lets the chrome end there.
 */
@Composable
private fun ChatTabRow(tab: ChatTab, onTabChange: (ChatTab) -> Unit) {
    val colors = DsTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = DsSpacing.medium, vertical = DsSpacing.tiny),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Which tab is live is load-bearing, not decoration: the two views render a user message
        // completely differently — a right-aligned bubble in Chat, a `> line` of caption text in
        // the Trajectory ledger — so a reader who cannot tell at a glance concludes the chat itself
        // is broken.
        DsSegmented(
            segments = listOf(
                DsSegment(TAB_CHAT, stringResource(R.string.chat_tab)),
                DsSegment(TAB_TRAJECTORY, stringResource(R.string.trajectory_title)),
            ),
            selectedKey = if (tab == ChatTab.Chat) TAB_CHAT else TAB_TRAJECTORY,
            onSelect = { key ->
                onTabChange(if (key == TAB_CHAT) ChatTab.Chat else ChatTab.Trajectory)
            },
            role = Role.Tab,
        )
    }
    Spacer(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(colors.borderL1),
    )
}

private const val TAB_CHAT = "chat"
private const val TAB_TRAJECTORY = "trajectory"
