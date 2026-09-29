package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.labteto.dshmobile.R
import com.labteto.dshmobile.ui.components.DisclosureRow
import kotlinx.serialization.json.*

/** JSON strings can contain embedded JSON; expand those without losing the original copy value. */
@Composable
internal fun JsonDisclosure(title: String, value: JsonElement, depth: Int = 0) {
    var expanded by remember(value) { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val open = com.labteto.dshmobile.ui.components.LocalFileOpener.current
    DisclosureRow(title = title, expanded = expanded, onToggle = { expanded = !expanded }) {
        Column(Modifier.padding(start = 12.dp)) {
            if (value is JsonObject) {
                val imageId = (value["attachmentId"] as? JsonPrimitive)?.contentOrNull
                if (imageId != null && (value["type"]?.jsonPrimitive?.contentOrNull == "image" || value["mediaType"]?.jsonPrimitive?.contentOrNull?.startsWith("image/") == true)) {
                    com.labteto.dshmobile.ui.components.AttachmentImage(attachmentId = imageId, intrinsicWidth = (value["width"] as? JsonPrimitive)?.intOrNull ?: 512, intrinsicHeight = (value["height"] as? JsonPrimitive)?.intOrNull ?: 512)
                }
            }
            if (value is JsonPrimitive && value.isString && title in setOf("path", "absolutePath", "file_path", "filePath")) {
                previewPath(value.content)?.let { path -> TextButton(onClick = { open(path) }) { Text(stringResource(R.string.panel_preview)) } }
            }
            TextButton(onClick = { clipboard.setText(AnnotatedString(value.toString())) }) { Text(stringResource(R.string.common_copy)) }
            when {
                depth >= 8 -> SelectionContainer { Text(value.toString(), fontFamily = FontFamily.Monospace) }
                value is JsonObject -> value.forEach { (name, child) -> JsonDisclosure(name, child, depth + 1) }
                value is JsonArray -> value.forEachIndexed { i, child -> JsonDisclosure(i.toString(), child, depth + 1) }
                value is JsonPrimitive && value.isString -> {
                    val parsed = remember(value) { runCatching { Json.parseToJsonElement(value.content) }.getOrNull() }
                    if (parsed is JsonObject || parsed is JsonArray) JsonDisclosure("JSON", parsed, depth + 1)
                    else SelectionContainer { Text(value.content, fontFamily = FontFamily.Monospace) }
                }
                else -> SelectionContainer { Text(value.toString(), fontFamily = FontFamily.Monospace) }
            }
        }
    }
}

internal fun fuzzyContains(name: String, query: String): Boolean {
    val needle = query.trim().lowercase()
    if (needle.isEmpty()) return true
    var index = 0
    for (character in name.lowercase()) {
        if (character == needle[index]) index++
        if (index == needle.length) return true
    }
    return false
}

/** A host file path is never interpreted as an Android path or an arbitrary external scheme. */
internal fun previewPath(value: String): String? {
    val raw = value.trim().removeSurrounding("<", ">")
    if (raw.isEmpty() || raw.startsWith('#')) return null
    if (raw.startsWith("file://")) return runCatching { java.net.URI(raw).path }.getOrNull()
    if (Regex("^[A-Za-z]:[/\\\\]").containsMatchIn(raw)) return raw
    if (Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(raw)) return null
    return raw.substringBefore('#')
}
