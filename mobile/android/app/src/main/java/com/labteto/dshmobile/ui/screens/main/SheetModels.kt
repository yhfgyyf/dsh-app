package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.dto.ModelCatalogModel
import com.labteto.dshmobile.core.wire.dto.SessionModelsValue
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.DsBottomSheet
import com.labteto.dshmobile.ui.components.DsSegment
import com.labteto.dshmobile.ui.components.DsSegmented
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import kotlinx.coroutines.launch

/**
 * Model picker, grouped by provider.
 *
 * Two decisions live here, and they are not peers: which model, and — for a model that reasons —
 * how hard. The harness's own picker separates them into two panes for that reason. This sheet
 * keeps one list but nests the second decision inside the chosen model's card, so the tiers belong
 * visibly to the model they configure. Showing them under every model, as this sheet used to, put a
 * dead control under each row nobody had chosen and tripled the height of the list.
 */
@Composable
internal fun ModelsSheet(
    models: SessionModelsValue?,
    store: SessionStore,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val colors = DsTheme.colors
    DsBottomSheet(title = stringResource(R.string.models_title), onDismiss = onDismiss) {
        if (models == null) {
            Text(stringResource(R.string.common_loading), style = DsType.std14, color = colors.labelTertiary)
            return@DsBottomSheet
        }
        val current = models.current
        if (!models.routable) {
            Text(
                stringResource(R.string.models_unroutable),
                style = DsType.small13,
                color = colors.warnLabel,
            )
        }
        Column(
            modifier = Modifier
                .heightIn(max = 420.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(DsSpacing.tiny),
        ) {
            models.groups.forEach { group ->
                // The provider recedes: it names the shelf, and the models on it are the choice.
                // At the section weight this used the group read as loud as its own contents.
                Text(
                    group.name,
                    style = DsType.xsmall12,
                    color = colors.labelTertiary,
                    modifier = Modifier.padding(
                        start = DsSpacing.small,
                        top = DsSpacing.small,
                        bottom = DsSpacing.tiny,
                    ),
                )
                group.models.forEach { model ->
                    val isCurrent = current.provider == group.id && current.model == model.id
                    ModelRow(
                        model = model,
                        selected = isCurrent,
                        selectedEffort = current.reasoningEffort.takeIf { isCurrent },
                        onSelect = { scope.launch { store.selectModel(group.id, model.id) } },
                        onSelectEffort = { effort ->
                            scope.launch { store.selectModel(group.id, model.id, effort) }
                        },
                    )
                }
            }
            models.failures.forEach { failure ->
                Text(
                    stringResource(R.string.err_model_unavailable, "${failure.name}: ${failure.message}"),
                    style = DsType.caption11,
                    color = colors.warnLabel,
                    modifier = Modifier.padding(horizontal = DsSpacing.small, vertical = DsSpacing.tiny),
                )
            }
        }
    }
}

/**
 * One model as a card: the name, and — once it is the live one — the reasoning tiers beneath.
 *
 * The chosen card carries an accent wash and border rather than only a blue name and a check
 * stranded at the far edge. A tick 300dp from the word it qualifies is a footnote; a tinted card is
 * the answer to "which one am I on" read at a glance, which is the only question this sheet exists
 * to answer.
 */
@Composable
private fun ModelRow(
    model: ModelCatalogModel,
    selected: Boolean,
    selectedEffort: String?,
    onSelect: () -> Unit,
    onSelectEffort: (String) -> Unit,
) {
    val colors = DsTheme.colors
    val efforts = model.reasoning?.efforts.orEmpty()
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = DsShapes.menu,
        // Every model is a card, not only the chosen one. A bare name on the sheet's own colour
        // offers nothing to press: a phone has no hover to discover it with, so the row has to look
        // like a control while it is at rest. `bgModulePlatform` is the one surface that steps off
        // the sheet in both themes — the three `bgLayer` tokens are all pure white in light mode.
        color = if (selected) colors.accentTertiary else colors.bgModulePlatform,
        border = if (selected) BorderStroke(1.dp, colors.accent) else null,
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    // `selectable` rather than `clickable`: the tint carries the state visually, so
                    // the selection has to reach assistive tech some other way.
                    .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
                    .heightIn(min = DsSpacing.touchTarget)
                    .padding(horizontal = DsSpacing.medium, vertical = DsSpacing.small),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        model.name,
                        style = DsType.std14Strong,
                        color = if (selected) colors.accent else colors.labelPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    model.description?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            it,
                            style = DsType.caption11,
                            color = colors.labelTertiary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (selected) {
                    Spacer(Modifier.width(DsSpacing.small))
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = stringResource(R.string.models_current),
                        tint = colors.accent,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
            if (selected && efforts.isNotEmpty()) {
                Column(
                    modifier = Modifier.padding(
                        start = DsSpacing.medium,
                        end = DsSpacing.medium,
                        bottom = DsSpacing.medium,
                    ),
                    verticalArrangement = Arrangement.spacedBy(DsSpacing.xsmall),
                ) {
                    // Four bare words under a model name say nothing about what they set. The
                    // harness gives the tier list a pane with a title; here the title is one line.
                    Text(
                        stringResource(R.string.models_reasoning_effort),
                        style = DsType.caption11,
                        color = colors.labelTertiary,
                    )
                    DsSegmented(
                        segments = efforts.map { DsSegment(it.id, it.name) },
                        selectedKey = selectedEffort,
                        onSelect = onSelectEffort,
                    )
                }
            }
        }
    }
}
