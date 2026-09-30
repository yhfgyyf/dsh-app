package com.labteto.dshmobile.ui.screens.main

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.session.PreviewReadException
import com.labteto.dshmobile.core.session.copyWorkspacePreview
import com.labteto.dshmobile.core.wire.dto.WorkspaceByteReadOptions
import com.labteto.dshmobile.data.SessionStore
import java.io.File
import java.io.OutputStream
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.*

/** Both actions transfer the original file, even when its preview is a converted PDF. */
@Composable
internal fun WorkspaceFileActions(store: SessionStore, key: ComposerKey, path: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<Uri?>(null) }
    val name = remember(path) { path.replace('\\', '/').substringAfterLast('/').replace(Regex("[\\p{Cntrl}]"), "_").trim('.', ' ').take(80).ifBlank { "download" } }
    val mime = remember(path) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.', "").lowercase(Locale.ROOT)) ?: "application/octet-stream" }

    suspend fun transfer(output: OutputStream) = withContext(Dispatchers.IO) {
        val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
        val stat = api.workspaceFileStat(key.sessionId, path).requireValue()
        copyWorkspacePreview(stat, 256L * 1024 * 1024, output, { range ->
            api.workspaceFileReadBytes(key.sessionId, path, WorkspaceByteReadOptions(range = range))
        })
    }
    fun report(error: Exception) {
        failure = if (error is PreviewReadException) context.getString(
            if (error.reason == PreviewReadException.Reason.TOO_LARGE) R.string.panel_too_large else R.string.panel_changed,
        ) else context.getString(R.string.file_download_failed)
    }
    fun share(uri: Uri) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, name)
            clipData = ClipData.newUri(context.contentResolver, name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, context.getString(R.string.file_share)))
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri ->
        if (uri == null) { busy = false }
        else scope.launch {
            var completed = false
            try {
                withContext(Dispatchers.IO) {
                    (context.contentResolver.openOutputStream(uri, "w") ?: error("Cannot open destination")).use { transfer(it) }
                }
                completed = true
                saved = uri
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { report(e) }
            finally {
                // ACTION_CREATE_DOCUMENT created this destination; discard our incomplete transfer.
                if (!completed) withContext(NonCancellable + Dispatchers.IO) { runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) } }
                busy = false
            }
        }
    }
    Column {
        Row {
            TextButton(enabled = !busy, onClick = {
                failure = null; busy = true
                try { save.launch(name) } catch (e: Exception) { busy = false; report(e) }
            }) { Text(stringResource(R.string.file_download)) }
            TextButton(enabled = !busy, onClick = {
                busy = true; failure = null
                scope.launch {
                    var cache: File? = null
                    var shared = false
                    try {
                        // Sharing a completed download also works after the computer disconnects.
                        saved?.let { share(it); return@launch }
                        val file = withContext(Dispatchers.IO) {
                            val root = File(context.cacheDir, "shared").apply { mkdirs() }
                            // Keep grants usable after opening another app, and retire only old app-owned copies.
                            root.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000L }?.forEach { it.deleteRecursively() }
                            File(root, UUID.randomUUID().toString()).apply { mkdirs() }.also { cache = it }.resolve(name).also { file ->
                                file.outputStream().buffered().use { transfer(it) }
                            }
                        }
                        share(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
                        shared = true
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { report(e) }
                    finally { if (!shared) cache?.deleteRecursively(); busy = false }
                }
            }) { Text(stringResource(R.string.file_share)) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        saved?.let { Text(stringResource(R.string.file_download_done), Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall) }
        failure?.let { Text(it, Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error) }
    }
}
