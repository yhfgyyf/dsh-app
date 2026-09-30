package com.labteto.dshmobile.ui.screens.main

import androidx.compose.runtime.*
import com.labteto.dshmobile.core.wire.dto.*

internal class PreviewTab(val path: String) {
    val scroll = androidx.compose.foundation.ScrollState(0)
    var stat by mutableStateOf<WorkspaceFileStat?>(null)
    var text by mutableStateOf<String?>(null)
    var bytes by mutableStateOf<ByteArray?>(null)
    var nextLine by mutableIntStateOf(1)
    var eof by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
}

internal class PanelState(val key: ComposerKey) {
    val directoryScroll = mutableMapOf<String, androidx.compose.foundation.lazy.LazyListState>()
    var section by mutableIntStateOf(0)
    var directory by mutableStateOf(".")
    var listing by mutableStateOf<WorkspaceDirectoryListing?>(null)
    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    val previews = mutableStateListOf<PreviewTab>()
    var selectedPreview by mutableIntStateOf(0)
    var terminals by mutableStateOf<List<WebTerminalInfo>>(emptyList())
    var selectedTerminal by mutableStateOf<String?>(null)
    var shells by mutableStateOf<List<TerminalShell>>(emptyList())
    var shellPath by mutableStateOf<String?>(null)
    fun open(path: String) {
        val index = previews.indexOfFirst { it.path == path }
        if (index >= 0) selectedPreview = index else {
            // Bound decoded documents retained by this panel; the selected document can be reloaded.
            previews.forEach { it.bytes = null }
            previews.add(PreviewTab(path)); selectedPreview = previews.lastIndex
        }
        section = 1
    }
}

internal class PanelRepository {
    private val panels = mutableMapOf<ComposerKey, PanelState>()
    fun get(key: ComposerKey): PanelState = panels.getOrPut(key) { PanelState(key) }
}
