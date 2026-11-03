package dev.shuttersense.app

import dev.shuttersense.app.agent.CameraTools
import dev.shuttersense.app.agent.ImageStats
import dev.shuttersense.app.agent.ImageTools
import dev.shuttersense.app.agent.PreparedImage
import dev.shuttersense.app.ccapi.CameraAddress
import dev.shuttersense.app.ccapi.CameraHttp
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.ccapi.CcapiException
import dev.shuttersense.app.ccapi.SettingException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.URI

/**
 * End to end against the simulated camera (`npm run sim` in the repo root).
 * Skipped unless SIM_URL is set, e.g. SIM_URL=http://127.0.0.1:8080.
 */
class SimulatorSmokeTest {
    private val sim: String? = System.getenv("SIM_URL")

    /** Image work needs Android's Bitmap; here we only check the bytes are a JPEG. */
    private val images = object : ImageTools {
        override suspend fun prepare(jpeg: ByteArray, maxSide: Int, quality: Double): PreparedImage {
            assertTrue(jpeg.size > 1000 && jpeg[0] == 0xFF.toByte() && jpeg[1] == 0xD8.toByte())
            return PreparedImage("data:image/jpeg;base64,", 0, 0, ImageStats(0, 0, 0.0, 0.0))
        }
    }

    @Test
    fun drivesTheSimulatedCamera() = runBlocking<Unit> {
        assumeTrue("SIM_URL not set", sim != null)
        val uri = URI(sim!!)
        val client = CcapiClient(CameraHttp.transport(CameraAddress(uri.host, uri.port)))
        val tools = CameraTools(client, images)
        val name = tools.connect()
        println("Connected: $name")
        println("State: ${tools.getState()}")
        val (lookText, _) = tools.look()
        println(lookText)

        // From Av at 1/250 s, so the changes below happen whatever the scene (or the other test) left.
        tools.set(mapOf("shootingmode" to JsonPrimitive("tv"), "tv" to JsonPrimitive("1/250")))
        tools.set(mapOf("shootingmode" to JsonPrimitive("av")))
        val r = tools.set(
            mapOf(
                "shootingmode" to JsonPrimitive("tv"),
                "tv" to JsonPrimitive("1/1000"),
                "iso" to JsonPrimitive("auto"),
                "colortemperature" to JsonPrimitive(3200),
                "wb" to JsonPrimitive("colortemp"),
                "av" to JsonPrimitive("f1.0"),
            ),
        )
        println("Applied: ${r.applied}\nErrors: ${r.errors}")
        assertTrue(r.applied.any { it.startsWith("Mode") })
        assertTrue(r.applied.any { it.startsWith("Shutter") })
        assertEquals(1, r.errors.size) // aperture is chosen by the camera in Tv

        val shot = tools.shoot(true, 1)
        println("Shot 1 at ${shot.exposure}")
        assertTrue(shot.exposure.startsWith("Tv"))
        assertTrue(shot.exposure.contains("1/1000 s"))
        // Back to Av and auto white balance.
        tools.set(mapOf("shootingmode" to JsonPrimitive("av"), "wb" to JsonPrimitive("auto")))
    }

    /** The wider client API: live view detail, composite settings, clock, events, contents. */
    @Test
    fun exercisesTheWiderApi() = runBlocking<Unit> {
        assumeTrue("SIM_URL not set", sim != null)
        val uri = URI(sim!!)
        val c = CcapiClient(CameraHttp.transport(CameraAddress(uri.host, uri.port)))
        c.discover()

        val detail = c.liveDetail("both")
        assertTrue(detail.image!![0] == 0xFF.toByte())
        val hist = detail.info!!.histogram!!
        assertEquals(4, hist.size)
        assertTrue(hist.all { it.size == 256 })
        assertTrue(detail.info!!.afFrames.isNotEmpty())
        val frames = c.liveFrames("scrolldetail", "both").toList()
        assertTrue(frames.isNotEmpty() && frames.all { it.image != null && it.info != null })
        println("Live view: ${frames.size} streamed frames, sensor ${detail.info!!.sensorSize}")

        try {
            c.setPictureStyleDetail("standard", mapOf("sharpness_strength" to 9))
            fail("expected a rejection")
        } catch (e: SettingException) {
            println("Rejected: ${e.message}")
        }
        c.setWbShift(-3, 4)
        assertEquals(mapOf("ba" to -3, "mg" to 4), c.compositeSetting("wbshift").fields)
        c.setWbShift(0, 0)

        println("Clock: ${c.datetime().datetime}, battery ${c.battery()}, temperature ${c.temperature()}")
        c.poll("immediately", "ver100")
        c.poll()

        c.shutter(false)
        val path = c.waitForNewFile(20_000)
        val dir = c.directories(c.storages().first()).first()
        assertTrue(path in c.allFiles(dir))
        val info = c.fileInfo(path)
        val part = c.downloadRange(path, 2, 9)
        assertEquals(listOf(2L, 9L, info.fileSize), listOf(part.start, part.end, part.total))
        c.protectFile(path, true)
        try {
            c.deleteFile(path)
            fail("expected 409")
        } catch (e: CcapiException) {
            assertEquals(409, e.status)
        }
        c.protectFile(path, false)
        println("Contents: $path, ${info.fileSize} bytes, ${c.contentsCount(dir)}")

        c.setFunction("autopoweroff", "300")
        val event = c.monitorEvents().first()
        assertTrue("autopoweroff" in event)
        c.setFunction("autopoweroff", "60")
    }
}
