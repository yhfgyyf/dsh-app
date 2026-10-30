package com.labteto.dshmobile.core.wire

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

/** Kotlin port of april-jk/dsh-mobile-plugin sealed-tunnel-v1 (MIT, see THIRD_PARTY.md). */
object CentralCrypto {
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun decode(text: String, size: Int? = null): ByteArray {
        require(text.matches(Regex("[A-Za-z0-9_-]*")))
        val bytes = Base64.getUrlDecoder().decode(text)
        require(encode(bytes) == text && (size == null || bytes.size == size))
        return bytes
    }
    fun random(): String = encode(ByteArray(32).also { SecureRandom().nextBytes(it) })
    fun canonical(vararg values: Any): ByteArray = JsonArray(values.map {
        when (it) { is Int -> JsonPrimitive(it); else -> JsonPrimitive(it.toString()) }
    }).toString().toByteArray(Charsets.UTF_8)
    fun hmac(key: ByteArray, value: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256")); doFinal(value)
    }
    fun proof(key: String, session: String, random: String): String = encode(hmac(decode(key, 32), canonical("dsh-e2ee-client", 1, session, random)))
    fun client(key: String, session: String, clientRandom: String, hello: JsonObject): CentralCipher {
        require(hello["accessSessionId"]?.jsonPrimitive?.content == session)
        val serverRandom = hello.getValue("serverRandomB64").jsonPrimitive.content
        decode(clientRandom, 32); decode(serverRandom, 32)
        val expected = hmac(decode(key, 32), canonical("dsh-e2ee-server", 1, session, clientRandom, serverRandom))
        require(MessageDigest.isEqual(expected, decode(hello.getValue("serverProofB64").jsonPrimitive.content, 32))) { "Desktop identity proof failed" }
        val salt = MessageDigest.getInstance("SHA-256").digest(canonical("dsh-e2ee-salt", 1, session, clientRandom, serverRandom))
        val prk = hmac(salt, decode(key, 32))
        fun expand(info: String, count: Int) = hmac(prk, info.toByteArray() + byteArrayOf(1)).copyOf(count)
        return CentralCipher(session, expand("dsh-e2ee-v1:c2d:key", 32), expand("dsh-e2ee-v1:c2d:nonce", 4), expand("dsh-e2ee-v1:d2c:key", 32), expand("dsh-e2ee-v1:d2c:nonce", 4))
    }
}
class CentralCipher(private val session: String, private val sendKey: ByteArray, private val sendNonce: ByteArray, private val receiveKey: ByteArray, private val receiveNonce: ByteArray) {
    private var sendSeq = 0L
    private var receiveSeq = 0L
    private fun cipher(mode: Int, key: ByteArray, prefix: ByteArray, seq: Long, direction: String): Cipher {
        require(seq >= 0 && seq < Long.MAX_VALUE)
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, ByteBuffer.allocate(12).put(prefix).putLong(seq).array()))
            updateAAD(CentralCrypto.canonical("dsh-e2ee", 1, session, direction, seq.toString()))
        }
    }
    @Synchronized fun seal(value: JsonObject): JsonObject {
        val seq = sendSeq++
        val encrypted = cipher(Cipher.ENCRYPT_MODE, sendKey, sendNonce, seq, "c2d").doFinal(value.toString().toByteArray())
        return buildJsonObject { put("seq", seq.toString()); put("ciphertextB64", CentralCrypto.encode(encrypted)) }
    }
    @Synchronized fun open(value: JsonObject): JsonObject {
        val text = value.getValue("seq").jsonPrimitive.content
        require(text == receiveSeq.toString()) { "Replayed or reordered frame" }
        val bytes = cipher(Cipher.DECRYPT_MODE, receiveKey, receiveNonce, receiveSeq, "d2c").doFinal(CentralCrypto.decode(value.getValue("ciphertextB64").jsonPrimitive.content))
        val result = Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        receiveSeq++
        return result
    }
}
