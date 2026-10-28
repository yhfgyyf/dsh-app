package com.labteto.dshmobile.core.session

import java.nio.ByteBuffer
import java.nio.ByteOrder

const val SPEECH_SAMPLE_RATE = 16000
const val WAVE_HEADER_BYTES = 44

/** The host accepts canonical mono, 16-bit PCM WAV rather than device-specific media containers. */
fun speechWave(pcm: ByteArray): ByteArray {
    require(pcm.isNotEmpty() && pcm.size % 2 == 0)
    return ByteBuffer.allocate(WAVE_HEADER_BYTES + pcm.size).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray(Charsets.US_ASCII)); putInt(36 + pcm.size)
        put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); putInt(16)
        putShort(1); putShort(1); putInt(SPEECH_SAMPLE_RATE); putInt(SPEECH_SAMPLE_RATE * 2)
        putShort(2); putShort(16); put("data".toByteArray(Charsets.US_ASCII)); putInt(pcm.size); put(pcm)
    }.array()
}
