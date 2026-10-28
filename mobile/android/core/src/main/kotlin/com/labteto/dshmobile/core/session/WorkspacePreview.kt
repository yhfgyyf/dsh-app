package com.labteto.dshmobile.core.session

import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.core.wire.dto.WorkspaceByteRange
import com.labteto.dshmobile.core.wire.dto.WorkspaceFileContent
import com.labteto.dshmobile.core.wire.dto.WorkspaceFileStat
import java.io.OutputStream
import java.util.Locale
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

enum class PreviewKind { TEXT, IMAGE, GIF, PDF, OFFICE, MEDIA }

fun previewKind(path: String): PreviewKind = when (path.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
    "doc", "docx", "xls", "xlsx", "ppt", "pptx" -> PreviewKind.OFFICE
    "png", "jpg", "jpeg", "webp", "bmp", "avif", "ico" -> PreviewKind.IMAGE
    "gif" -> PreviewKind.GIF
    "pdf" -> PreviewKind.PDF
    "mp4", "m4v", "webm", "mov", "mkv", "3gp", "mp3", "m4a", "aac", "wav", "ogg", "flac" -> PreviewKind.MEDIA
    else -> PreviewKind.TEXT
}

class PreviewReadException(val reason: Reason) : IllegalStateException(reason.name) {
    enum class Reason { TOO_LARGE, CHANGED }
}

/** Bounded windows avoid the RPC body cap and keep videos out of the phone's heap. */
suspend fun copyWorkspacePreview(
    stat: WorkspaceFileStat,
    maxBytes: Long,
    output: OutputStream,
    read: suspend (WorkspaceByteRange) -> RpcResult<WorkspaceFileContent>,
    progress: (Long) -> Unit = {},
) {
    if ((stat.bytes ?: 0) > maxBytes) throw PreviewReadException(PreviewReadException.Reason.TOO_LARGE)
    var offset = 0L
    do {
        currentCoroutineContext().ensureActive()
        val range = WorkspaceByteRange(offset, minOf(1024 * 1024L, maxBytes - offset + 1).toInt())
        val data = when (val result = read(range)) {
            is RpcResult.Ok -> result.value
            is RpcResult.Err -> throw IllegalStateException("${result.error.code}: ${result.error.message}")
        }
        if (data.version != stat.version || data.absolutePath != stat.absolutePath || data.offset != offset ||
            data.data.size > range.length || (stat.bytes != null && data.bytes != stat.bytes)) {
            throw PreviewReadException(PreviewReadException.Reason.CHANGED)
        }
        if (offset + data.data.size > maxBytes) throw PreviewReadException(PreviewReadException.Reason.TOO_LARGE)
        if (data.data.isEmpty() && !data.eof) throw PreviewReadException(PreviewReadException.Reason.CHANGED)
        output.write(data.data)
        offset += data.data.size
        progress(offset)
        if (data.eof && stat.bytes != null && offset != stat.bytes) throw PreviewReadException(PreviewReadException.Reason.CHANGED)
    } while (!data.eof)
}
