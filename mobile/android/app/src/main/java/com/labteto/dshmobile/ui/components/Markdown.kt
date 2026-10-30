package com.labteto.dshmobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.key
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.text.ClickableText
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.ui.theme.DsColors
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import com.labteto.dshmobile.ui.theme.DshTheme
import com.labteto.dshmobile.core.markdown.SyntaxToken
import com.labteto.dshmobile.core.markdown.highlightCode
import com.labteto.dshmobile.core.markdown.isHighlighted
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.stringResource
import com.labteto.dshmobile.R
import com.labteto.dshmobile.ui.theme.Ds
import com.labteto.dshmobile.core.markdown.safeHttpUrl
import com.labteto.dshmobile.core.markdown.MdBlock
import com.labteto.dshmobile.core.markdown.parseMarkdown
import androidx.compose.ui.text.style.TextDecoration
import kotlin.math.pow

val LocalFileOpener = staticCompositionLocalOf<(String) -> Unit> { {} }

/**
 * Block-level Markdown renderer: fenced code blocks, #-#### headings, bullet and
 * ordered lists, blockquotes, and paragraphs with inline **bold**, *italic*,
 * `code` chips and [links](https://example.com). Tables render as plain text.
 */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val colors = DsTheme.colors
    // The parser lives in :core (pure JVM) so it is unit-testable and survives a renderer rewrite.
    // List items arrive one per block, so runs of them are regrouped here: the renderer needs the
    // whole list at once to number an ordered list and to keep the markers in one column.
    val blocks = remember(text) { groupListBlocks(parseMarkdown(text)) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { render ->
            when (render) {
                is RenderBlock.ListRun -> MdListBlock(render)
                is RenderBlock.Of -> when (val block = render.block) {
                is MdBlock.Heading -> {
                    val style = when (block.level) {
                        1 -> DsType.mdH1
                        2 -> DsType.mdH2
                        3 -> DsType.mdH3
                        else -> DsType.mdH4
                    }
                    InlineMarkdown(block.text, style.copy(color = colors.labelPrimary), Modifier.padding(top = 10.dp))
                }
                is MdBlock.Paragraph -> InlineMarkdown(
                    block.lines.joinToString(" "),
                    DsType.mdBody.copy(color = colors.labelPrimary),
                    Modifier.fillMaxWidth(),
                )
                                is MdBlock.Blockquote -> MdBlockquote(block)
                is MdBlock.Code -> CodeBlock(block.lang, block.code)
                is MdBlock.HorizontalRule -> HorizontalRuleLine()
                    is MdBlock.Table -> MdTableBlock(block)
                    // Grouped away above; the parser never hands a bare item to the renderer.
                    is MdBlock.ListItem -> Unit
                }
            }
        }
    }
}


// ---- List grouping -----------------------------------------------------------

/**
 * A consecutive run of [MdBlock.ListItem]s, as one renderable block.
 *
 * The core parser emits one block per item because that is what the grammar produces; a renderer
 * needs the run so it can number an ordered list and align every marker in one column. The run is
 * broken by a blank line only — a nested item stays in its parent's run, carrying its own indent.
 */
private sealed interface RenderBlock {
    data class Of(val block: MdBlock) : RenderBlock
    data class ListRun(val items: List<MdBlock.ListItem>, val ordered: Boolean) : RenderBlock
}

/** Wrap runs of list items into [ListRun], leaving every other block untouched and in order. */
private fun groupListBlocks(blocks: List<MdBlock>): List<RenderBlock> {
    val out = mutableListOf<RenderBlock>()
    val run = mutableListOf<MdBlock.ListItem>()
    fun flush() {
        if (run.isEmpty()) return
        // Orderedness comes from the first item of the run; a list cannot be half-numbered.
        out += RenderBlock.ListRun(run.toList(), ordered = run.first().ordered)
        run.clear()
    }
    blocks.forEach { block ->
        if (block is MdBlock.ListItem) run += block
        else {
            flush()
            out += RenderBlock.Of(block)
        }
    }
    flush()
    return out
}

// ---- Inline rendering ------------------------------------------------------

private sealed interface InlineSegment {
    data class Plain(val text: String) : InlineSegment
    data class Bold(val text: String) : InlineSegment
    data class Italic(val text: String) : InlineSegment
    data class Code(val text: String) : InlineSegment
    data class Link(val text: String, val url: String) : InlineSegment
}

private fun parseInlineSegments(text: String): List<InlineSegment> {
    val segments = mutableListOf<InlineSegment>()
    val sb = StringBuilder()
    var i = 0
    fun flush() {
        if (sb.isNotEmpty()) {
            segments += InlineSegment.Plain(sb.toString())
            sb.clear()
        }
    }
    while (i < text.length) {
        when {
            text.startsWith("`", i) -> {
                val end = text.indexOf('`', i + 1)
                if (end != -1) {
                    flush()
                    segments += InlineSegment.Code(text.substring(i + 1, end))
                    i = end + 1
                } else {
                    sb.append(text[i]); i++
                }
            }
            text.startsWith("**", i) -> {
                val end = text.indexOf("**", i + 2)
                if (end != -1) {
                    flush()
                    segments += InlineSegment.Bold(text.substring(i + 2, end))
                    i = end + 2
                } else {
                    sb.append(text[i]); i++
                }
            }
            text.startsWith("*", i) -> {
                val end = text.indexOf("*", i + 1)
                if (end != -1) {
                    flush()
                    segments += InlineSegment.Italic(text.substring(i + 1, end))
                    i = end + 1
                } else {
                    sb.append(text[i]); i++
                }
            }
            text.startsWith("[", i) -> {
                val close = text.indexOf("](", i + 1)
                if (close != -1) {
                    val end = text.indexOf(')', close + 2)
                    if (end != -1) {
                        flush()
                        segments += InlineSegment.Link(text.substring(i + 1, close), text.substring(close + 2, end))
                        i = end + 1
                    } else {
                        sb.append(text[i]); i++
                    }
                } else {
                    sb.append(text[i]); i++
                }
            }
            else -> {
                sb.append(text[i]); i++
            }
        }
    }
    flush()
    return segments
}

/** Renders one line of markdown with bold/italic/code/link spans. */
@Composable
private fun InlineMarkdown(text: String, style: TextStyle, modifier: Modifier = Modifier) {
    val colors = DsTheme.colors
    val codeStyle = style.copy(
        fontFamily = DsType.codeFont,
        color = colors.labelPrimary,
    )
    val result = remember(text, style, codeStyle, colors) {
        buildInlineContent(text, codeStyle, colors)
    }
    val openFile = LocalFileOpener.current
    val uriHandler = LocalUriHandler.current
    val hasLinks = remember(result) { result.getStringAnnotations("url", 0, result.length).isNotEmpty() }
    if (!hasLinks) {
        // Nothing to tap, so the text is laid out inside a SelectionContainer instead: long-press
        // selects and the platform handles the copy affordance. A ClickableText swallows the
        // long-press, which is why the two cannot share one branch. Re-keyed on the shared dismiss
        // token so a tap elsewhere in the transcript clears the selection (see ChatTranscript).
        val dismissToken = LocalSelectionDismiss.current.value
        key(dismissToken) {
            SelectionContainer(modifier = modifier) {
                Text(result, style = style)
            }
        }
        return
    }
    ClickableText(
        result, modifier = modifier, style = style,
        onClick = { offset ->
            result.getStringAnnotations("url", offset, offset).firstOrNull()?.item?.let { raw ->
                // http(s) goes to the browser, anything else is treated as a path into the
                // session's own files. The scheme check lives in core so a reply cannot smuggle
                // `intent:`/`file:` past this handler by dressing it up as a link.
                val url = safeHttpUrl(raw)
                if (url != null) runCatching { uriHandler.openUri(url) }
                else com.labteto.dshmobile.ui.screens.main.previewPath(raw)?.let(openFile)
            }
        },
    )
}

private fun buildInlineContent(
    text: String,
    codeStyle: TextStyle,
    colors: DsColors,
): AnnotatedString {
    val builder = AnnotatedString.Builder()
    parseInlineSegments(text).forEach { segment ->
        when (segment) {
            is InlineSegment.Plain -> builder.append(segment.text)
            is InlineSegment.Bold -> builder.withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(segment.text) }
            is InlineSegment.Italic -> builder.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(segment.text) }
            is InlineSegment.Code -> builder.withStyle(
                SpanStyle(fontFamily = codeStyle.fontFamily, color = codeStyle.color),
            ) { append(segment.text) }
            is InlineSegment.Link -> {
                builder.pushStringAnnotation("url", segment.url)
                builder.withStyle(SpanStyle(color = colors.accent)) { append(segment.text) }
                builder.pop()
            }
        }
    }
    return builder.toAnnotatedString()
}

// ---- Block renderers --------------------------------------------------------

@Composable
private fun MdListBlock(block: RenderBlock.ListRun) {
    val colors = DsTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(start = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Numbering counts only top-level ordered items; a nested item restarts nothing.
        var ordinal = 0
        block.items.forEach { item ->
            if (item.indent == 0) ordinal++
            // Resolved once: `checked` is null for an ordinary item, and the marker, the tint and
            // the strikethrough all key off the same answer.
            val done = item.checked == true
            Row(
                Modifier
                    .fillMaxWidth()
                    // Nesting is indentation, not a second list: the parser already resolved depth.
                    .padding(start = (item.indent * 16).dp),
                verticalAlignment = Alignment.Top,
            ) {
                when {
                    // A task item's marker *is* its state, so the box replaces the bullet rather
                    // than sitting beside it — two marks for one item read as a nested list.
                    item.checked != null -> {
                        Text(
                            if (done) "\u2611" else "\u2610",
                            style = DsType.mdBody.copy(color = if (done) colors.success else colors.labelTertiary),
                            modifier = Modifier.width(18.dp),
                        )
                    }
                    block.ordered -> Text(
                        "$ordinal.",
                        style = DsType.mdBody.copy(color = colors.labelSecondary),
                        textAlign = TextAlign.End,
                        modifier = Modifier.width(28.dp),
                    )
                    else -> Text(
                        "\u2022",
                        style = DsType.mdBody.copy(color = colors.labelSecondary),
                        modifier = Modifier.width(18.dp),
                    )
                }
                Spacer(Modifier.width(6.dp))
                // A finished task reads as done: struck through, not just ticked.
                val style = if (done) {
                    DsType.mdBody.copy(color = colors.labelTertiary, textDecoration = TextDecoration.LineThrough)
                } else {
                    DsType.mdBody.copy(color = colors.labelPrimary)
                }
                InlineMarkdown(item.text, style, Modifier.weight(1f))
            }
        }
    }
}

/** A `---` rule: a hairline, inset to the text column so it does not touch the screen edges. */
@Composable
private fun HorizontalRuleLine() {
    val colors = DsTheme.colors
    Spacer(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .height(1.dp)
            .background(colors.borderL2),
    )
}

/**
 * A GFM table.
 *
 * Rendered as a real grid rather than as a run of text lines: the parser resolved per-column
 * alignment, and discarding it would put a numbers column on the same footing as prose. Cells
 * carry inline markup, so each goes through [InlineMarkdown].
 */
@Composable
private fun MdTableBlock(block: MdBlock.Table) {
    val colors = DsTheme.colors
    // Column widths follow the content instead of splitting evenly. Equal weights gave a one-digit
    // `#` column the same share as a prose column, so a table of numbers and text came out with a
    // wide empty first column and a cramped second. Weights here are proportional to the longest
    // cell each column holds, which is a single pass over the parsed table.
    val weights = remember(block) { tableColumnWeights(block) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(DsShapes.block)
            .border(1.dp, colors.borderL1, DsShapes.block),
    ) {
        Row(Modifier.fillMaxWidth().background(colors.codeBlockBanner)) {
            block.header.forEachIndexed { index, cell ->
                TableCell(
                    text = cell,
                    alignment = block.alignments.getOrNull(index) ?: MdBlock.Alignment.LEFT,
                    header = true,
                    modifier = Modifier.weight(weights.getOrElse(index) { 1f }),
                )
            }
        }
        block.rows.forEachIndexed { rowIndex, row ->
            if (rowIndex > 0) {
                Spacer(Modifier.fillMaxWidth().height(1.dp).background(colors.borderL1))
            }
            Row(Modifier.fillMaxWidth()) {
                row.forEachIndexed { index, cell ->
                    TableCell(
                        text = cell,
                        alignment = block.alignments.getOrNull(index) ?: MdBlock.Alignment.LEFT,
                        header = false,
                        modifier = Modifier.weight(weights.getOrElse(index) { 1f }),
                    )
                }
            }
        }
    }
}


/**
 * Per-column layout weights, proportional to each column's longest cell.
 *
 * The share is `width^0.65` rather than raw width: a straight ratio lets one long cell (a URL, an
 * English sentence in a table of numbers) take almost the whole line and squeeze every other column
 * to an ellipsis. Compressing the exponent keeps the ordering — wider content gets more room —
 * while bounding how much of the table any single column can claim.
 *
 * A floor of one character keeps the ratio finite; an empty column still gets a share.
 */
private fun tableColumnWeights(table: MdBlock.Table): List<Float> {
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    if (columns == 0) return emptyList()
    return (0 until columns).map { index ->
        val longest = sequence {
            yield(table.header.getOrNull(index))
            table.rows.forEach { yield(it.getOrNull(index)) }
        }.filterNotNull().maxOfOrNull { it.length } ?: 0
        maxOf(longest, 1).toDouble().pow(0.65).toFloat()
    }
}

@Composable
private fun TableCell(
    text: String,
    alignment: MdBlock.Alignment,
    header: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = DsTheme.colors
    val textAlign = when (alignment) {
        MdBlock.Alignment.LEFT -> TextAlign.Start
        MdBlock.Alignment.CENTER -> TextAlign.Center
        MdBlock.Alignment.RIGHT -> TextAlign.End
    }
    Box(modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
        // A header cell is emphasis, not a different size: at mdSmall a bigger weight on the
        // header would out-weigh the body text it is labelling.
        val style = DsType.mdSmall.copy(
            color = if (header) colors.labelPrimary else colors.labelSecondary,
            fontWeight = if (header) FontWeight.Medium else FontWeight.Normal,
            textAlign = textAlign,
        )
        InlineMarkdown(text, style, Modifier.fillMaxWidth())
    }
}

@Composable
private fun MdBlockquote(block: MdBlock.Blockquote) {
    val colors = DsTheme.colors
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(vertical = 2.dp)) {
        Box(
            Modifier
                .width(2.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(1.dp))
                .background(colors.citation),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            block.lines.forEach { line ->
                InlineMarkdown(line, DsType.mdSmall.copy(color = colors.labelTertiary), Modifier.fillMaxWidth())
            }
        }
    }
}

/** Fenced code block with a sticky banner (lang · copy) and a mono pre. */
@Composable
private fun CodeBlock(lang: String?, code: String, modifier: Modifier = Modifier) {
    val colors = DsTheme.colors
    val clipboard = LocalClipboardManager.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(DsShapes.block)
            .background(colors.codeBlockBg)
            .border(1.dp, colors.borderL1, DsShapes.block),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.codeBlockBanner)
                .padding(start = 12.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                lang ?: stringResource(R.string.tool_copy_code),
                style = DsType.caption11Strong.copy(fontFamily = DsType.codeFont, color = colors.labelCaption),
                color = colors.labelCaption,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.Filled.ContentCopy,
                contentDescription = stringResource(R.string.tool_copy_code),
                tint = colors.labelTertiary,
                modifier = Modifier
                    .size(16.dp)
                    .clip(DsShapes.chip)
                    .clickable { clipboard.setText(AnnotatedString(code)) }
                    .padding(2.dp),
            )
        }
        // Highlighting is resolved in the pure-JVM core lexer; this layer only maps its token
        // kinds to theme colors, so a merge that rewrites the renderer cannot break the tokenizer
        // and a theme change cannot break the lexer.
        val highlighted = remember(code, lang) { codeAnnotated(code, lang) }
        Text(
            highlighted,
            style = DsType.mdCode,
            color = colors.labelPrimary,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
}


/**
 * Run the core lexer over [code] and paint each span with the theme's syntax color.
 *
 * Joining the lines back with `\n` is what keeps the result plain text: the renderer lays it out
 * as ordinary code with no per-line layout of its own, and the lexer guarantees the concatenation
 * reproduces the input exactly.
 */
private fun codeAnnotated(code: String, lang: String?): AnnotatedString {
    if (!isHighlighted(lang)) return AnnotatedString(code)
    val builder = AnnotatedString.Builder()
    highlightCode(code, lang).forEachIndexed { index, line ->
        if (index > 0) builder.append('\n')
        line.forEach { span ->
            // Syntax tints are a fixed palette, not theme roles: code reads the same in light and
            // dark, the way it does on the web client.
            val color = when (span.token) {
                SyntaxToken.Comment -> Ds.SyntaxComment
                SyntaxToken.String -> Ds.SyntaxString
                SyntaxToken.Number -> Ds.SyntaxConstant
                SyntaxToken.Keyword -> Ds.SyntaxKeyword
                SyntaxToken.Function -> Ds.SyntaxFunction
                SyntaxToken.Type -> Ds.SyntaxConstant
                SyntaxToken.Plain -> null
            }
            if (color == null) builder.append(span.text)
            else builder.withStyle(SpanStyle(color = color)) { append(span.text) }
        }
    }
    return builder.toAnnotatedString()
}

@Preview(showBackground = true, widthDp = 360)
@Composable
private fun MarkdownTextPreview() {
    DshTheme {
        MarkdownText(
            text = """
                # Heading

                A paragraph with **bold**, *italic* and `inline code` plus a [link](https://example.com).

                - first item
                - second item

                1. ordered one
                2. ordered two

                > A quoted thought.

                ```kotlin
                val answer = 42
                ```

                | col a | col b |
                | ----- | ----- |
                | 1     | 2     |
            """.trimIndent(),
            modifier = Modifier.padding(16.dp),
        )
    }
}
