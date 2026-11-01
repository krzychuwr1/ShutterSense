package dev.secondshooter.app

import dev.secondshooter.app.agent.CameraTools
import dev.secondshooter.app.agent.ImageStats
import dev.secondshooter.app.agent.ImageTools
import dev.secondshooter.app.agent.PreparedImage
import dev.secondshooter.app.ccapi.CameraAddress
import dev.secondshooter.app.ccapi.CameraHttp
import dev.secondshooter.app.ccapi.CcapiClient
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
        // Back to where the scene started, so the simulator is left as found.
        tools.set(mapOf("shootingmode" to JsonPrimitive("av"), "wb" to JsonPrimitive("auto")))
    }
}
