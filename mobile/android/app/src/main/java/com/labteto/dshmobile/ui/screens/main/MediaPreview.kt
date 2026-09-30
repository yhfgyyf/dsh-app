package com.labteto.dshmobile.ui.screens.main

import android.net.Uri
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.session.PreviewReadException
import com.labteto.dshmobile.core.session.copyWorkspacePreview
import com.labteto.dshmobile.core.wire.dto.WorkspaceByteReadOptions
import com.labteto.dshmobile.core.wire.dto.WorkspaceFileStat
import com.labteto.dshmobile.data.SessionStore
import java.io.File
import kotlinx.coroutines.*

/** GIF animation uses the system WebView's decoder, with no script, file or network access. */
@Composable
internal fun AnimatedImagePreview(bytes: ByteArray, modifier: Modifier) {
    val html = remember(bytes) {
        """<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{margin:0;display:grid;place-items:center;min-height:100vh}img{max-width:100%;height:auto}</style><img src="data:image/gif;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}">"""
    }
    AndroidView(modifier = modifier.fillMaxWidth(), factory = { context -> WebView(context).apply {
        settings.javaScriptEnabled = false
        settings.allowFileAccess = false; settings.allowContentAccess = false
        settings.blockNetworkLoads = true
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
        }
        loadDataWithBaseURL("https://preview.invalid/", html, "text/html", "utf-8", null)
    } }, onRelease = { it.destroy() })
}

/** Playback reads only a bounded, version-checked copy in the app's private cache. */
@Composable
internal fun RemoteMediaPreview(store: SessionStore, key: ComposerKey, path: String, stat: WorkspaceFileStat, modifier: Modifier) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var file by remember(stat.version) { mutableStateOf<File?>(null) }
    var received by remember(stat.version) { mutableLongStateOf(0) }
    var error by remember(stat.version) { mutableStateOf<String?>(null) }
    val video = remember { VideoView(context) }
    LaunchedEffect(key, path, stat.version) {
        val cached = File.createTempFile("preview-media-", ".${path.substringAfterLast('.', "mp4")}", context.cacheDir)
        try {
            val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
            withContext(Dispatchers.IO) {
                cached.outputStream().buffered().use { output ->
                    copyWorkspacePreview(stat, 256L * 1024 * 1024, output, { range ->
                        api.workspaceFileReadBytes(key.sessionId, path, WorkspaceByteReadOptions(range = range))
                    }, { received = it })
                }
            }
            file = cached
            awaitCancellation()
        } catch (e: CancellationException) { throw e }
        catch (e: PreviewReadException) {
            error = context.getString(if (e.reason == PreviewReadException.Reason.TOO_LARGE) R.string.panel_too_large else R.string.panel_changed)
        } catch (e: Exception) { error = e.message }
        finally { file = null; video.stopPlayback(); cached.delete() }
    }
    DisposableEffect(video, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) video.pause() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); video.stopPlayback() }
    }
    Column(modifier.fillMaxWidth()) {
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
        if (file == null && error == null) {
            Text(stringResource(R.string.panel_media_loading), Modifier.padding(16.dp))
            if ((stat.bytes ?: 0) > 0) LinearProgressIndicator(progress = { (received.toFloat() / stat.bytes!!).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            else LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        file?.let { cached -> key(cached) {
            AndroidView(modifier = Modifier.weight(1f).fillMaxWidth(), factory = {
                video.apply {
                    val controller = MediaController(context)
                    controller.setAnchorView(this)
                    setMediaController(controller)
                    setOnPreparedListener { controller.show(0) }
                    setOnErrorListener { _, _, _ -> error = context.getString(R.string.panel_media_unsupported); true }
                    setVideoURI(Uri.fromFile(cached))
                }
            }, onRelease = { it.stopPlayback() })
        } }
    }
}
