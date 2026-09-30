package com.labteto.dshmobile.connection

import com.labteto.dshmobile.core.wire.TransportFailure
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The same two statuses mean four different things depending on whether this device paired with the
 * address, and each of the four sends the person to a different place to fix it.
 */
class ProbeOutcomeMappingTest {

    /**
     * A relay refuses this device with 403 and never 401, so a 401 through one is the harness
     * refusing the relay. Reading it as "pair again" is what sent the reporter of #40 to the phone
     * for a fault on the computer.
     */
    @Test
    fun `a 401 through a paired relay is the harness refusing the relay`() {
        assertEquals(
            ProbeOutcome.RelayUnauthenticated,
            probeOutcomeOf(TransportFailure.UNAUTHENTICATED, relay = true, detail = "401"),
        )
    }

    @Test
    fun `a 403 through a paired relay is still this device's credential`() {
        assertEquals(
            ProbeOutcome.PairingRequired,
            probeOutcomeOf(TransportFailure.TRUST_FENCE, relay = true, detail = "403"),
        )
    }

    @Test
    fun `a harness reached directly keeps its own 401 and 403`() {
        assertEquals(
            ProbeOutcome.Unauthenticated,
            probeOutcomeOf(TransportFailure.UNAUTHENTICATED, relay = false, detail = "401"),
        )
        assertEquals(
            ProbeOutcome.TrustFence,
            probeOutcomeOf(TransportFailure.TRUST_FENCE, relay = false, detail = "403"),
        )
    }

    /** A throttle is a real harness address; its own wording is what the person should read. */
    @Test
    fun `an outcome with nothing more specific keeps the carrier's words`() {
        assertEquals(
            ProbeOutcome.Other("rate limited"),
            probeOutcomeOf(TransportFailure.RATE_LIMITED, relay = true, detail = "rate limited"),
        )
    }
}
