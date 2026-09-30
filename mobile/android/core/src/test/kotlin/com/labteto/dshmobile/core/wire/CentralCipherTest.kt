package com.labteto.dshmobile.core.wire

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CentralCipherTest {
    private fun vector() = Json.parseToJsonElement(javaClass.getResource("/remote-vector.json")!!.readText()).jsonObject
    @Test fun kotlinMatchesNodeByteForByteAndRejectsReplay() {
        val v = vector()
        assertEquals(v.text("proof"), CentralCrypto.proof(v.text("key"), v.text("session"), v.text("clientRandom")))
        val cipher = CentralCrypto.client(v.text("key"), v.text("session"), v.text("clientRandom"), v.getValue("hello").jsonObject)
        assertEquals(v.getValue("c2d"), cipher.seal(remoteObject("text" to "中文 remote", "n" to 7)))
        assertEquals(remoteObject("ok" to true), cipher.open(v.getValue("d2c").jsonObject))
        assertThrows(IllegalArgumentException::class.java) { cipher.open(v.getValue("d2c").jsonObject) }
    }
    @Test fun rejectsWrongKeyAndUnsafeRelayAddress() {
        val v = vector()
        assertThrows(IllegalArgumentException::class.java) { CentralCrypto.client(CentralCrypto.encode(ByteArray(32)), v.text("session"), v.text("clientRandom"), v.getValue("hello").jsonObject) }
        for (url in listOf("http://example.com", "https://name:password@example.com", "https://example.com/?token=a", "https://example.com/path")) {
            assertThrows(IllegalArgumentException::class.java) { centralOrigin(url) }
        }
        assertEquals("https://example.com", centralOrigin("https://example.com"))
    }
}
