package dev.shuttersense.app

import dev.shuttersense.app.glasses.shotReply
import org.junit.Assert.assertEquals
import org.junit.Test

class ShotReplyTest {
    @Test
    fun repliesToAShotApproval() {
        for (t in listOf("Shoot", "yes", "  Yeah, go", "ok", "Okay then", "sure", "go ahead", "Take it", "do it now")) assertEquals(t, true, shotReply(t))
        for (t in listOf("no", "Nope", "skip it", "don't", "please do not", "stop", "wait", "not yet", "cancel that", "hmm, no")) assertEquals(t, false, shotReply(t))
        for (t in listOf("make it warmer first", "brighter", "", "shooting star", "know", "gopher")) assertEquals(t, null, shotReply(t))
        // A yes at the start wins over a later no.
        assertEquals(true, shotReply("yes, no more changes"))
    }
}
