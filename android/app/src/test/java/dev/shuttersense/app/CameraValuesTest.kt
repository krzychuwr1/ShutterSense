package dev.shuttersense.app

import dev.shuttersense.app.ccapi.CameraValues
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CameraValuesTest {
    @Test
    fun parsesShutterSpeeds() {
        assertEquals(1 / 125.0, CameraValues.tvSeconds("1/125")!!, 1e-12)
        assertEquals(0.5, CameraValues.tvSeconds("0\"5")!!, 1e-12)
        assertEquals(1.3, CameraValues.tvSeconds("1\"3")!!, 1e-12)
        assertEquals(30.0, CameraValues.tvSeconds("30\"")!!, 1e-12)
        assertNull(CameraValues.tvSeconds("bulb"))
    }

    @Test
    fun parsesApertureIsoAndCompensation() {
        assertEquals(2.8, CameraValues.avNumber("f2.8")!!, 1e-12)
        assertEquals(22.0, CameraValues.avNumber("f22")!!, 1e-12)
        assertEquals(800, CameraValues.isoNumber("800"))
        assertNull(CameraValues.isoNumber("auto"))
        assertEquals(4 / 3.0, CameraValues.evStops("+1_1/3")!!, 1e-12)
        assertEquals(-2 / 3.0, CameraValues.evStops("-0_2/3")!!, 1e-12)
        assertEquals(0.0, CameraValues.evStops("+0.0")!!, 1e-12)
        assertEquals(-2.0, CameraValues.evStops("-2.0")!!, 1e-12)
    }

    @Test
    fun prettyValuesMatchTheWebApp() {
        assertEquals("f/2.8", CameraValues.prettyValue("av", "f2.8"))
        assertEquals("f/8", CameraValues.prettyValue("av", "f8.0"))
        assertEquals("1/1000 s", CameraValues.prettyValue("tv", "1/1000"))
        assertEquals("0.5 s", CameraValues.prettyValue("tv", "0\"5"))
        assertEquals("30 s", CameraValues.prettyValue("tv", "30\""))
        assertEquals("ISO auto", CameraValues.prettyValue("iso", "auto"))
        assertEquals("+1⅔ EV", CameraValues.prettyValue("exposure", "+1_2/3"))
        assertEquals("-⅓ EV", CameraValues.prettyValue("exposure", "-0_1/3"))
        assertEquals("±0 EV", CameraValues.prettyValue("exposure", "+0.0"))
        assertEquals("-2 EV", CameraValues.prettyValue("exposure", "-2.0"))
        assertEquals("Av", CameraValues.prettyValue("shootingmode", "av"))
        assertEquals("–", CameraValues.prettyValue("tv", ""))
    }

    @Test
    fun diffLines() {
        assertEquals("ISO 3200 → 800", CameraValues.diffLine("iso", "3200", "800"))
        assertEquals("Shutter 1/60 s → 1/1000 s", CameraValues.diffLine("tv", "1/60", "1/1000"))
        assertEquals("Colour temp. 5200 K → 3200 K", CameraValues.diffLine("colortemperature", 5200, 3200))
        assertEquals("Exp. comp. ±0 EV → +1⅔ EV", CameraValues.diffLine("exposure", "+0.0", "+1_2/3"))
    }
}
