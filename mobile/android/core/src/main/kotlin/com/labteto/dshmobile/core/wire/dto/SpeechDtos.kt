package com.labteto.dshmobile.core.wire.dto

import kotlinx.serialization.Serializable

/** One complete WAV goes to the computer's selected recognizer; no session is changed by it. */
@Serializable data class SpeechTranscriptionRequest(val audioBase64: String, val providerId: String, val language: String)
@Serializable data class SpeechTranscript(val text: String, val audioSeconds: Double, val inferenceSeconds: Double)
@Serializable data class SpeechSelection(val providerId: String, val language: String)
@Serializable data class SpeechPreparation(val phase: String)
@Serializable data class SpeechProvider(val id: String, val name: String, val location: String,
    val languages: List<String>, val preparation: SpeechPreparation)
@Serializable data class SpeechCatalog(val providers: List<SpeechProvider>, val selection: SpeechSelection,
    val maxAudioBytes: Int, val maxDurationSeconds: Double)
