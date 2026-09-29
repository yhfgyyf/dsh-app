package com.labteto.dshmobile.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The LAN sweep only ever walks the phone's own /24, so an address outside it can neither be
 * scanned for nor routed to. Catching that before probing turns a four-second timeout that blames
 * the firewall into an instant, correct explanation.
 */
class SubnetCheckTest {

    @Test
    fun `an address in the same 24 is accepted`() {
        assertTrue(sameSubnet("192.168.1.20", listOf("192.168.1.44")))
    }

    @Test
    fun `an address in another 24 is rejected`() {
        assertFalse(sameSubnet("192.168.0.20", listOf("192.168.1.44")))
        assertFalse(sameSubnet("10.0.0.5", listOf("192.168.1.44")))
    }

    @Test
    fun `any of the device's interfaces counts`() {
        assertTrue(sameSubnet("10.0.0.5", listOf("192.168.1.44", "10.0.0.9")))
    }

    /** A hostname cannot be compared to a subnet, so it must not be reported as a mismatch. */
    @Test
    fun `non-literal hosts are not judged`() {
        assertTrue(sameSubnet("my-pc.local", listOf("192.168.1.44")))
        assertTrue(sameSubnet("localhost", listOf("192.168.1.44")))
        assertTrue(sameSubnet("192.168.1", listOf("192.168.1.44")))
        assertTrue(sameSubnet("192.168.1.999", listOf("192.168.1.44")))
        assertTrue(sameSubnet("", listOf("192.168.1.44")))
    }

    /** No IPv4 of our own — an IPv6-only or offline device — means nothing to compare against. */
    @Test
    fun `a device with no ipv4 makes no claim`() {
        assertTrue(sameSubnet("192.168.1.20", emptyList()))
    }
}
