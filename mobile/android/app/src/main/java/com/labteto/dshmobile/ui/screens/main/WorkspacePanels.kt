package com.labteto.dshmobile.ui.screens.main

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.core.wire.dto.*
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.components.MarkdownText
import com.labteto.dshmobile.ui.theme.DsTheme
import kotlinx.coroutines.*
import java.io.File

internal fun <T> RpcResult<T>.requireValue(): T = when (this) {
    is RpcResult.Ok -> value
    is RpcResult.Err -> throw IllegalStateException("${error.code}: ${error.message}")
}

@Composable
internal fun WorkspacePanels(store: SessionStore, state: PanelState, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val key = state.key
    val activeDocument = state.previews.getOrNull(state.selectedPreview)?.path
    fun listDirectory(path: String) {
        if (state.busy) return
        state.busy = true; state.error = null
        scope.launch {
            try {
                val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
                state.listing = api.workspaceFileList(key.sessionId, path).requireValue()
                state.directory = path
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { state.error = e.message }
            finally { state.busy = false }
        }
    }
    LaunchedEffect(key) { if (state.listing == null) listDirectory(state.directory) }
    // Invalidate previews when the host reports a file observation. OS-only changes are checked
    // by stat each time a tab opens and by the explicit Refresh action.
    //
    // Harness 0.1.7 watches one named target per stream rather than the whole workspace, so each
    // open preview gets a watch of its own; the set follows the tabs. A 0.1.6 host refuses the
    // `path` argument and is watched workspace-wide instead, once.
    val mux = store.muxForHost(key.host)
    val watched = state.previews.map { it.path }.distinct()
    var workspaceWide by remember(key, mux) { mutableStateOf(false) }
    fun invalidate(raw: kotlinx.serialization.json.JsonElement) {
        val frame = com.labteto.dshmobile.core.wire.decodeFromJsonElement(WorkspaceFileWatchFrame.serializer(), raw)
        frame.change?.let { change ->
            state.previews.filter { it.stat?.absolutePath == change.absolutePath }.forEach {
                if (change.absent || it.stat?.version != change.version) { it.stat = null; it.bytes = null; it.text = null }
            }
        }
    }
    if (mux != null && !workspaceWide) {
        watched.forEach { path -> key(path) {
            LaunchedEffect(key, mux, path) {
                try {
                    mux.openStream("workspaceFiles/changes", kotlinx.serialization.json.buildJsonObject {
                        put("workspaceFileScopeId", kotlinx.serialization.json.JsonPrimitive(key.sessionId))
                        put("path", kotlinx.serialization.json.JsonPrimitive(path))
                    }).collect { invalidate(it) }
                } catch (e: CancellationException) { throw e }
                catch (e: com.labteto.dshmobile.core.wire.RemoteStreamException) {
                    if (e.error.code == "gateway/arguments-invalid") workspaceWide = true
                }
                catch (_: Exception) { /* File reads remain available without the optional observation feed. */ }
            }
        } }
    }
    if (mux != null && workspaceWide) {
        LaunchedEffect(key, mux) {
            try {
                mux.openStream("workspaceFiles/changes", kotlinx.serialization.json.buildJsonObject {
                    put("workspaceFileScopeId", kotlinx.serialization.json.JsonPrimitive(key.sessionId))
                }).collect { invalidate(it) }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { /* As above: the feed is an optimisation, not a dependency. */ }
        }
    }
    CompositionLocalProvider(com.labteto.dshmobile.ui.components.LocalFileOpener provides { path: String ->
        state.open(activeDocument?.let { com.labteto.dshmobile.core.session.resolvePreviewReference(it, path) } ?: path)
    }) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = DsTheme.colors.bgBase) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_back)) }
                    Text(stringResource(R.string.panel_workspace), modifier = Modifier.padding(16.dp))
                }
                TabRow(selectedTabIndex = state.section) {
                    listOf(R.string.panel_files, R.string.panel_preview, R.string.panel_terminal).forEachIndexed { i, title ->
                        Tab(selected = state.section == i, onClick = { state.section = i }, text = { Text(stringResource(title)) })
                    }
                }
                when (state.section) {
                    0 -> {
                        Row(Modifier.fillMaxWidth()) {
                            TextButton(onClick = { listDirectory(".") }, enabled = !state.busy) { Text(stringResource(R.string.panel_root)) }
                            TextButton(onClick = { listDirectory(state.directory.substringBeforeLast('/', ".").ifEmpty { "." }) }, enabled = !state.busy) {
                                Text(stringResource(R.string.panel_parent))
                            }
                            TextButton(onClick = { listDirectory(state.directory) }, enabled = !state.busy) { Text(stringResource(R.string.common_retry)) }
                        }
                        Text(state.directory, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall)
                        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                        state.error?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
                        if (state.listing?.truncated == true) Text(stringResource(R.string.panel_truncated), Modifier.padding(16.dp))
                        LazyColumn(Modifier.weight(1f), state = state.directoryScroll.getOrPut(state.directory) { androidx.compose.foundation.lazy.LazyListState() }) {
                            items(state.listing?.entries.orEmpty(), key = { it.name }) { entry ->
                                ListItem(headlineContent = { Text(entry.name) },
                                    supportingContent = { Text(if (entry.type == "directory") stringResource(R.string.panel_folder) else entry.size?.let { "$it B" }.orEmpty()) },
                                    modifier = Modifier.clickable(enabled = !state.busy) {
                                        val path = if (state.directory == ".") entry.name else "${state.directory}/${entry.name}"
                                        if (entry.type == "directory") listDirectory(path) else state.open(path)
                                    })
                            }
                        }
                    }
                    1 -> {
                        if (state.previews.isEmpty()) Text(stringResource(R.string.panel_preview_empty), Modifier.padding(24.dp))
                        else {
                            Row(Modifier.horizontalScroll(rememberScrollState())) {
                                state.previews.forEachIndexed { i, preview ->
                                    TextButton(onClick = { state.selectedPreview = i }) { Text(preview.path.substringAfterLast('/').substringAfterLast('\\')) }
                                }
                            }
                            val index = state.selectedPreview.coerceIn(0, state.previews.lastIndex)
                            val preview = state.previews[index]
                            Row {
                                TextButton(onClick = { state.previews.removeAt(index); state.selectedPreview = (index - 1).coerceAtLeast(0) }) { Text(stringResource(R.string.common_close)) }
                                TextButton(onClick = { preview.stat = null; preview.text = null; preview.bytes = null }) { Text(stringResource(R.string.common_retry)) }
                            }
                            key(preview) { DocumentPreview(store, key, preview, Modifier.weight(1f)) }
                        }
                    }
                    2 -> TerminalPanel(store, state, Modifier.weight(1f))
                }
            }
        }
    }
    }
}

@Composable
private fun DocumentPreview(store: SessionStore, key: ComposerKey, tab: PreviewTab, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val extension = tab.path.substringAfterLast('.', "").lowercase()
    val binary = extension in setOf("png", "jpg", "jpeg", "webp", "gif", "pdf")
    fun load(more: Boolean = false) {
        if (tab.busy) return
        tab.busy = true; tab.error = null
        scope.launch {
            try {
                val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
                val stat = api.workspaceFileStat(key.sessionId, tab.path).requireValue()
                val changed = stat.version != tab.stat?.version
                if (changed) { tab.text = null; tab.bytes = null; tab.nextLine = 1; tab.eof = false }
                tab.stat = stat
                if (binary && tab.bytes == null) {
                    if ((stat.bytes ?: 0) > 32L * 1024 * 1024) error(context.getString(R.string.panel_too_large))
                    val data = api.workspaceFileReadBytes(key.sessionId, tab.path).requireValue()
                    if (data.version != stat.version) error(context.getString(R.string.panel_changed))
                    if (data.data.size > 32 * 1024 * 1024) error(context.getString(R.string.panel_too_large))
                    tab.bytes = data.data
                    tab.eof = true
                } else if (!binary && (tab.text == null || more)) {
                    val data = api.workspaceFileRead(key.sessionId, tab.path, WorkspaceFileRange(tab.nextLine)).requireValue()
                    if (data.version != stat.version) error(context.getString(R.string.panel_changed))
                    if (tab.text.orEmpty().length + data.text.length > 4 * 1024 * 1024) error(context.getString(R.string.panel_too_large))
                    tab.text = if (more && !changed) tab.text.orEmpty() + "\n" + data.text else data.text
                    tab.nextLine = data.offset + data.lines
                    tab.eof = data.eof || data.lines == 0
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { tab.error = e.message }
            finally { tab.busy = false }
        }
    }
    LaunchedEffect(tab) { load() }
    LaunchedEffect(tab.stat) { if (tab.stat == null) load() }
    Column(modifier.fillMaxWidth()) {
        SelectionContainer { Text(tab.path, Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall) }
        if (tab.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        tab.error?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
        TextButton(onClick = { scope.launch {
            try { store.apiForHost(key.host)?.sessionOpenWorkspacePath(key.sessionId, tab.path)?.requireValue() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { tab.error = e.message }
        } }) { Text(stringResource(R.string.panel_open_host)) }
        when {
            extension == "pdf" && tab.bytes != null -> PdfPreview(tab.bytes!!, Modifier.weight(1f))
            binary && tab.bytes != null -> {
                var image by remember(tab.bytes) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
                LaunchedEffect(tab.bytes) {
                    image = withContext(Dispatchers.Default) {
                        val bytes = tab.bytes ?: return@withContext null
                        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                        val options = BitmapFactory.Options().apply { inSampleSize = com.labteto.dshmobile.ui.media.sampleSizeFor(maxOf(bounds.outWidth, bounds.outHeight), 2048) }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
                    }
                    if (image == null) tab.error = context.getString(R.string.panel_failed)
                }
                image?.let { Image(it, tab.path, Modifier.fillMaxWidth().weight(1f)) }
            }
            extension in setOf("html", "htm", "svg") && tab.text != null -> {
                val base = android.net.Uri.Builder().scheme("https").authority("preview.invalid")
                    .path("/workspace/" + tab.path.replace('\\', '/').removePrefix("/")).build()
                AndroidView(modifier = Modifier.weight(1f).fillMaxWidth(), factory = { ctx ->
                    WebView(ctx).apply {
                        if (android.os.Build.VERSION.SDK_INT <= 30) setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
                        settings.javaScriptEnabled = false
                        settings.allowFileAccess = false; settings.allowContentAccess = false
                        settings.blockNetworkLoads = true
                        webViewClient = object : WebViewClient() {
                            private var totalBytes = 0L
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
                            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                                val denied = { WebResourceResponse("text/plain", "utf-8", java.io.ByteArrayInputStream(ByteArray(0))) }
                                val uri = request?.url ?: return denied()
                                if (uri.scheme != "https" || uri.host != "preview.invalid") return denied()
                                val relative = uri.path?.let { com.labteto.dshmobile.core.session.relativePreviewResource(base.path.orEmpty(), it) }
                                    ?.takeIf { it.isNotBlank() } ?: return denied()
                                return try {
                                    val bytes = runBlocking(Dispatchers.IO) {
                                        withTimeout(10000) {
                                            val api = store.apiForHost(key.host) ?: return@withTimeout null
                                            val data = api.workspaceFileReadBytes(
                                                key.sessionId, relative, WorkspaceByteReadOptions(baseFile = tab.path),
                                            ).requireValue()
                                            if ((data.bytes ?: 0) > 4 * 1024 * 1024 || data.data.size > 4 * 1024 * 1024) return@withTimeout null
                                            data.data
                                        }
                                    } ?: return denied()
                                    synchronized(this) { totalBytes += bytes.size; if (totalBytes > 32 * 1024 * 1024) return denied() }
                                    val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(relative.substringAfterLast('.')) ?: "application/octet-stream"
                                    WebResourceResponse(mime, "utf-8", bytes.inputStream())
                                } catch (_: Exception) { denied() }
                            }
                        }
                    }
                }, update = { it.loadDataWithBaseURL(base.toString(), tab.text.orEmpty(), if (extension == "svg") "image/svg+xml" else "text/html", "utf-8", null) },
                    onRelease = { it.destroy() })
            }
            tab.text != null -> SelectionContainer(Modifier.weight(1f).verticalScroll(tab.scroll).padding(16.dp)) {
                if (extension in setOf("md", "markdown")) MarkdownText(tab.text.orEmpty())
                else Text(tab.text.orEmpty(), fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
            }
        }
        if (!tab.eof && tab.text != null) TextButton(onClick = { load(true) }, enabled = !tab.busy) { Text(stringResource(R.string.panel_more)) }
    }
}

@Composable
private fun PdfPreview(bytes: ByteArray, modifier: Modifier) {
    val context = LocalContext.current
    var page by remember(bytes) { mutableIntStateOf(0) }
    var count by remember(bytes) { mutableIntStateOf(0) }
    var failure by remember(bytes) { mutableStateOf(false) }
    var bitmap by remember(bytes, page) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    LaunchedEffect(bytes, page) {
        bitmap = withContext(Dispatchers.IO) {
            val file = File.createTempFile("preview-", ".pdf", context.cacheDir)
            try {
                file.writeBytes(bytes)
                ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                    PdfRenderer(fd).use { pdf ->
                        count = pdf.pageCount
                        if (count == 0) return@withContext null
                        pdf.openPage(page.coerceIn(0, count - 1)).use { p ->
                            val scale = minOf(2f, 2048f / maxOf(p.width, p.height))
                            val image = Bitmap.createBitmap((p.width * scale).toInt().coerceAtLeast(1), (p.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                            image.eraseColor(android.graphics.Color.WHITE)
                            p.render(image, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            image.asImageBitmap()
                        }
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { failure = true; null }
            finally { file.delete() }
        }
    }
    Column(modifier) {
        if (failure) Text(stringResource(R.string.panel_failed))
        bitmap?.let { Image(it, null, Modifier.weight(1f).fillMaxWidth()) }
        Row {
            TextButton(onClick = { page-- }, enabled = page > 0) { Text(stringResource(R.string.common_back)) }
            Text("${page + 1} / $count", Modifier.padding(16.dp))
            TextButton(onClick = { page++ }, enabled = page + 1 < count) { Text(stringResource(R.string.panel_next)) }
        }
    }
}
