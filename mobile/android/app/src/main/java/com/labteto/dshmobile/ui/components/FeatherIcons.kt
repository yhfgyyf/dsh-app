package com.labteto.dshmobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The Feather glyphs the transcript and chrome use, traced as Compose vectors.
 *
 * Feather (https://feathericons.com, MIT © Cole Bemis) — see `THIRD_PARTY_NOTICES.md`. The set is
 * inlined rather than pulled in as a dependency for the same reason the harness ships its own
 * `ic_ds_*` icons inline: fifteen glyphs is not worth a library, and the ones that matter here have
 * to sit on the same 24-unit grid with the same 2-unit round-capped stroke as the desktop UI they
 * mirror. Material's own icons are a different drawing language (filled, 20-unit optical sizing) and
 * mixing the two in one row reads as a mistake.
 *
 * Every glyph is stroke-only and drawn in black, so `Icon`'s tint colours it.
 */
internal object FeatherIcons {

    /** `terminal` — the shell tools (bash, pwsh). */
    val Terminal: ImageVector by lazy {
        feather("Terminal") {
            moveTo(4f, 17f); lineTo(10f, 11f); lineTo(4f, 5f)
            moveTo(12f, 19f); lineTo(20f, 19f)
        }
    }

    /** `file-text` — reading a file. */
    val FileText: ImageVector by lazy {
        feather("FileText") {
            documentOutline()
            moveTo(16f, 13f); lineTo(8f, 13f)
            moveTo(16f, 17f); lineTo(8f, 17f)
            moveTo(10f, 9f); lineTo(8f, 9f)
        }
    }

    /** `file-plus` — creating a file. */
    val FilePlus: ImageVector by lazy {
        feather("FilePlus") {
            documentOutline()
            moveTo(12f, 18f); lineTo(12f, 12f)
            moveTo(9f, 15f); lineTo(15f, 15f)
        }
    }

    /** `edit-3` — editing a file. */
    val Edit3: ImageVector by lazy {
        feather("Edit3") {
            moveTo(12f, 20f); horizontalLineToRelative(9f)
            moveTo(16.5f, 3.5f)
            arcToRelative(2.121f, 2.121f, 0f, isMoreThanHalf = false, isPositiveArc = true, 3f, 3f)
            lineTo(7f, 19f)
            lineToRelative(-4f, 1f)
            lineToRelative(1f, -4f)
            lineTo(16.5f, 3.5f)
            close()
        }
    }

    /** `search` — grep, glob, web search. */
    val Search: ImageVector by lazy {
        feather("Search") {
            circle(11f, 11f, 8f)
            moveTo(21f, 21f); lineTo(16.65f, 16.65f)
        }
    }

    /** `globe` — web fetch / retrieval cards. */
    val Globe: ImageVector by lazy {
        feather("Globe") {
            circle(12f, 12f, 10f)
            moveTo(2f, 12f); lineTo(22f, 12f)
            moveTo(12f, 2f)
            arcToRelative(15.3f, 15.3f, 0f, isMoreThanHalf = false, isPositiveArc = true, 4f, 10f)
            arcToRelative(15.3f, 15.3f, 0f, isMoreThanHalf = false, isPositiveArc = true, -4f, 10f)
            arcToRelative(15.3f, 15.3f, 0f, isMoreThanHalf = false, isPositiveArc = true, -4f, -10f)
            arcToRelative(15.3f, 15.3f, 0f, isMoreThanHalf = false, isPositiveArc = true, 4f, -10f)
            close()
        }
    }

    /** `tool` — an unclassified tool call. */
    val Tool: ImageVector by lazy {
        feather("Tool") {
            moveTo(14.7f, 6.3f)
            arcToRelative(1f, 1f, 0f, isMoreThanHalf = false, isPositiveArc = false, 0f, 1.4f)
            lineToRelative(1.6f, 1.6f)
            arcToRelative(1f, 1f, 0f, isMoreThanHalf = false, isPositiveArc = false, 1.4f, 0f)
            lineToRelative(3.77f, -3.77f)
            arcToRelative(6f, 6f, 0f, isMoreThanHalf = false, isPositiveArc = true, -7.94f, 7.94f)
            lineToRelative(-6.91f, 6.91f)
            arcToRelative(2.12f, 2.12f, 0f, isMoreThanHalf = false, isPositiveArc = true, -3f, -3f)
            lineToRelative(6.91f, -6.91f)
            arcToRelative(6f, 6f, 0f, isMoreThanHalf = false, isPositiveArc = true, 7.94f, -7.94f)
            lineToRelative(-3.76f, 3.76f)
            close()
        }
    }

    /** `code` — `run_code` and diff cards. */
    val Code: ImageVector by lazy {
        feather("Code") {
            moveTo(16f, 18f); lineTo(22f, 12f); lineTo(16f, 6f)
            moveTo(8f, 6f); lineTo(2f, 12f); lineTo(8f, 18f)
        }
    }

    /** `git-branch` — workflow rows. */
    val GitBranch: ImageVector by lazy {
        feather("GitBranch") {
            moveTo(6f, 3f); lineTo(6f, 15f)
            circle(18f, 6f, 3f)
            circle(6f, 18f, 3f)
            moveTo(18f, 9f)
            arcToRelative(9f, 9f, 0f, isMoreThanHalf = false, isPositiveArc = true, -9f, 9f)
        }
    }

    /** `check-square` — todo docks. */
    val CheckSquare: ImageVector by lazy {
        feather("CheckSquare") {
            moveTo(9f, 11f); lineTo(12f, 14f); lineTo(22f, 4f)
            moveTo(21f, 12f)
            verticalLineToRelative(7f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, -2f, 2f)
            horizontalLineTo(5f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, -2f, -2f)
            verticalLineTo(5f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = true, 2f, -2f)
            horizontalLineToRelative(11f)
        }
    }

    /** `archive` — compaction rows. */
    val Archive: ImageVector by lazy {
        feather("Archive") {
            moveTo(21f, 8f); lineTo(21f, 21f); lineTo(3f, 21f); lineTo(3f, 8f)
            rectangle(1f, 3f, 22f, 5f)
            moveTo(10f, 12f); lineTo(14f, 12f)
        }
    }

    /** `alert-triangle` — warnings and connection banners. */
    val AlertTriangle: ImageVector by lazy {
        feather("AlertTriangle") {
            moveTo(10.29f, 3.86f)
            lineTo(1.82f, 18f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, 1.71f, 3f)
            horizontalLineToRelative(16.94f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, 1.71f, -3f)
            lineTo(13.71f, 3.86f)
            arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, -3.42f, 0f)
            close()
            moveTo(12f, 9f); lineTo(12f, 13f)
            moveTo(12f, 17f); lineTo(12.01f, 17f)
        }
    }

    /** `info` — the details-panel button. Outline, unlike Material's filled disc. */
    val Info: ImageVector by lazy {
        feather("Info") {
            circle(12f, 12f, 10f)
            moveTo(12f, 16f); lineTo(12f, 12f)
            moveTo(12f, 8f); lineTo(12.01f, 8f)
        }
    }

    /** `menu` — the drawer button. */
    val Menu: ImageVector by lazy {
        feather("Menu") {
            moveTo(3f, 6f); lineTo(21f, 6f)
            moveTo(3f, 12f); lineTo(21f, 12f)
            moveTo(3f, 18f); lineTo(21f, 18f)
        }
    }

    /** `chevron-right` — disclosure affordance; rotates to 90° when open. */
    val ChevronRight: ImageVector by lazy {
        feather("ChevronRight") {
            moveTo(9f, 18f); lineTo(15f, 12f); lineTo(9f, 6f)
        }
    }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** One Feather glyph: 24-unit grid, 2-unit round-capped stroke, no fill. */
private fun feather(name: String, block: PathBuilder.() -> Unit): ImageVector =
    ImageVector.Builder(
        name = "Feather.$name",
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            pathBuilder = block,
        )
    }.build()

/** SVG's `<circle>`, as the two half-arcs an `M … a … a …` path would draw. */
private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
    moveTo(cx - r, cy)
    arcToRelative(r, r, 0f, isMoreThanHalf = true, isPositiveArc = false, 2 * r, 0f)
    arcToRelative(r, r, 0f, isMoreThanHalf = true, isPositiveArc = false, -2 * r, 0f)
}

/** SVG's `<rect>` without corner radii. */
private fun PathBuilder.rectangle(x: Float, y: Float, width: Float, height: Float) {
    moveTo(x, y)
    horizontalLineToRelative(width)
    verticalLineToRelative(height)
    horizontalLineToRelative(-width)
    close()
}

/** The dog-eared page both `file-text` and `file-plus` are drawn on. */
private fun PathBuilder.documentOutline() {
    moveTo(14f, 2f)
    horizontalLineTo(6f)
    arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, -2f, 2f)
    verticalLineToRelative(16f)
    arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, 2f, 2f)
    horizontalLineToRelative(12f)
    arcToRelative(2f, 2f, 0f, isMoreThanHalf = false, isPositiveArc = false, 2f, -2f)
    verticalLineTo(8f)
    close()
    moveTo(14f, 2f); lineTo(14f, 8f); lineTo(20f, 8f)
}
