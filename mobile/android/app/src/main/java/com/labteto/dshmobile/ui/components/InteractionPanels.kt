package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType

// ---------------------------------------------------------------------------
// Interaction takeovers: sandbox-approval and plan review. The ask_user_question
// composer has its own file. These mirror the harness composer-takeover panels
// (amber strip, floating capsule, outline/primary pill actions).
// ---------------------------------------------------------------------------

/** Sandbox escalation / approval request panel. */
@Composable
fun ApprovalPanel(
    toolName: String,
    reason: String?,
    onAllow: () -> Unit,
    onReject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DsTheme.colors
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = DsShapes.approvalCard,
        color = colors.composerCard,
        border = BorderStroke(1.dp, colors.warnSecondary),
        shadowElevation = 2.dp,
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.warnTertiary)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.WarningAmber,
                    contentDescription = null,
                    tint = colors.warn,
                    modifier = Modifier.width(14.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    stringResource(R.string.approval_title),
                    style = DsType.small13Strong,
                    color = colors.warnLabel,
                )
            }
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.approval_reason, reason ?: toolName),
                    style = DsType.small13,
                    color = colors.labelSecondary,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DsButton(
                        text = stringResource(R.string.approval_allow_once),
                        onClick = onAllow,
                        variant = DsButtonVariant.Info,
                        size = DsButtonSize.Small,
                    )
                    DsButton(
                        text = stringResource(R.string.approval_reject),
                        onClick = onReject,
                        variant = DsButtonVariant.Outline,
                        size = DsButtonSize.Small,
                    )
                }
            }
        }
    }
}


/**
 * Plan-review takeover: the plan itself, then approve, refuse, or take it to the chat.
 *
 * A plan review rides the ordinary question channel but is a different decision, so it gets the
 * card built for it rather than a generic multiple choice. [planReviewOf] decides which — and
 * declines anything this card could not answer in full, because the card answers one question and
 * the host refuses a batch shorter than the request it resolves.
 */
@Composable
internal fun PlanReviewPanel(
    review: PlanReview,
    busy: Boolean,
    onApprove: () -> Unit,
    onDecline: () -> Unit,
    onDiscuss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = DsTheme.colors
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = DsShapes.approvalCard,
        color = colors.composerCard,
        border = BorderStroke(1.dp, colors.warnSecondary),
        shadowElevation = 2.dp,
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.warnTertiary)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.plan_review_title),
                    style = DsType.small13Strong,
                    color = colors.warnLabel,
                )
            }
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 220.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    MarkdownText(review.plan)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DsButton(
                        text = stringResource(R.string.plan_review_approve),
                        onClick = onApprove,
                        enabled = !busy,
                        variant = DsButtonVariant.Info,
                        size = DsButtonSize.Small,
                    )
                    // Only when the asker offered a second option. A refusal it never named is not
                    // one this card can send: the host checks every selected label against the
                    // question's own options and refuses one it does not recognise.
                    if (review.decline != null) {
                        DsButton(
                            text = stringResource(R.string.plan_review_decline),
                            onClick = onDecline,
                            enabled = !busy,
                            variant = DsButtonVariant.Outline,
                            size = DsButtonSize.Small,
                        )
                    }
                    // "Chat about it" dismisses the request rather than answering it with the
                    // refusal, which is what the harness's own card does — declining picks a stated
                    // option, whereas wanting to talk first is not one of the choices on offer.
                    DsButton(
                        text = stringResource(R.string.plan_review_discuss),
                        onClick = onDiscuss,
                        enabled = !busy,
                        variant = DsButtonVariant.Ghost,
                        size = DsButtonSize.Small,
                    )
                }
            }
        }
    }
}
