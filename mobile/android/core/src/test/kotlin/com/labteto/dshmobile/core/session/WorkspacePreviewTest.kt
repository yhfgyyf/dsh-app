package com.labteto.dshmobile.core.session

import com.labteto.dshmobile.core.wire.RpcResult
import com.labteto.dshmobile.core.wire.dto.WorkspaceFileContent
import com.labteto.dshmobile.core.wire.dto.WorkspaceFileStat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class WorkspacePreviewTest {
    @Test fun `binary formats never use UTF-8 text reads`() {
        assertEquals(PreviewKind.OFFICE, previewKind("report.DOCX"))
        assertEquals(PreviewKind.OFFICE, previewKind("report.xlsx"))
        assertEquals(PreviewKind.MEDIA, previewKind("video.mp4"))
        assertEquals(PreviewKind.MEDIA, previewKind("audio.mp3"))
        assertEquals(PreviewKind.GIF, previewKind("animated.gif"))
        assertEquals(PreviewKind.IMAGE, previewKind("image.png"))
        assertEquals(PreviewKind.PDF, previewKind("document.pdf"))
        assertEquals(PreviewKind.TEXT, previewKind("README.md"))
    }

    @Test fun `a file larger than an RPC response is copied through bounded windows`() = runTest {
        val source = ByteArray(17 * 1024 * 1024 + 5) { (it % 253).toByte() }
        val stat = WorkspaceFileStat("/fixture/movie.mp4", "v1", source.size.toLong())
        val output = ByteArrayOutputStream()
        var calls = 0
        copyWorkspacePreview(stat, 32L * 1024 * 1024, output, { range ->
            assertTrue(range.length <= 1024 * 1024)
            assertEquals(calls++ * 1024L * 1024, range.offset)
            val end = minOf(source.size, range.offset.toInt() + range.length)
            RpcResult.Ok(WorkspaceFileContent(stat.absolutePath, stat.version, stat.bytes, range.offset, end == source.size,
                source.copyOfRange(range.offset.toInt(), end)))
        })
        assertEquals(18, calls)
        assertArrayEquals(source, output.toByteArray())
    }

    @Test fun `changed incomplete stalled or oversized reads cannot become playable files`() = runTest {
        val stat = WorkspaceFileStat("/fixture/movie.mp4", "v1", 4)
        fun content(version: String = "v1", offset: Long = 0, data: ByteArray = ByteArray(4), eof: Boolean = true, path: String = stat.absolutePath) =
            WorkspaceFileContent(path, version, 4, offset, eof, data)
        for (bad in listOf(content(version = "v2"), content(offset = 1), content(data = ByteArray(2)),
            content(eof = false, data = ByteArray(0)), content(path = "/other"))) {
            val error = runCatching { copyWorkspacePreview(stat, 4, ByteArrayOutputStream(), { RpcResult.Ok(bad) }) }.exceptionOrNull()
            assertTrue(error is PreviewReadException)
            assertEquals(PreviewReadException.Reason.CHANGED, (error as PreviewReadException).reason)
        }
        val error = runCatching { copyWorkspacePreview(stat, 3, ByteArrayOutputStream(), { error("must not fetch") }) }.exceptionOrNull()
        assertEquals(PreviewReadException.Reason.TOO_LARGE, (error as PreviewReadException).reason)
    }

    @Test fun `speech WAV has the exact mono PCM header and audio bytes`() {
        val pcm = byteArrayOf(0, 1, -2, 3)
        val wav = speechWave(pcm)
        val data = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", wav.copyOfRange(0, 4).decodeToString())
        assertEquals(40, data.getInt(4))
        assertEquals("WAVEfmt ", wav.copyOfRange(8, 16).decodeToString())
        assertEquals(1, data.getShort(20).toInt())
        assertEquals(1, data.getShort(22).toInt())
        assertEquals(16000, data.getInt(24))
        assertEquals(32000, data.getInt(28))
        assertEquals(16, data.getShort(34).toInt())
        assertEquals(4, data.getInt(40))
        assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    }
}
