package dev.shuttersense.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.shuttersense.app.ccapi.Ability
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.sim.SimulatedCamera
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/**
 * The on-device simulator end to end: the bundled page in a headless WebView,
 * driven by the Kotlin CCAPI client. Prints timings to logcat (tag SimTest).
 */
@RunWith(AndroidJUnit4::class)
class SimulatedCameraTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var sim: SimulatedCamera

    private fun log(msg: String) {
        Log.i("SimTest", msg)
        println(msg)
    }

    private fun assertJpeg(bytes: ByteArray, what: String) {
        assertTrue("$what: ${bytes.size} bytes", bytes.size > 1000)
        assertTrue("$what starts like a JPEG", bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte())
        assertTrue("$what ends like a JPEG", bytes[bytes.size - 2] == 0xFF.toByte() && bytes[bytes.size - 1] == 0xD9.toByte())
    }

    private inline fun <T> timed(what: String, block: () -> T): T {
        val t0 = System.nanoTime()
        val r = block()
        log("$what: ${(System.nanoTime() - t0) / 1_000_000} ms")
        return r
    }

    @Before
    fun setUp() = runBlocking {
        sim = SimulatedCamera(context)
        timed("start()") { sim.start() }
        timed("start() again") { sim.start() }
    }

    @After
    fun tearDown() {
        sim.close()
    }

    @Test
    fun drivesTheSimulatedCamera() = runBlocking<Unit> {
        val c = CcapiClient(sim.transport)
        timed("discover") { c.discover() }
        log("Device: ${c.deviceInfo()}")
        val settings = timed("settings") { c.settings() }
        assertTrue(settings.containsKey("av") && settings.containsKey("tv") && settings.containsKey("iso"))

        // Live view: single frames, as the camera screen polls them.
        c.startLiveView()
        assertJpeg(c.liveFrame(), "first live frame")
        // Round trip vs. the simulator's own time (x-sim-ms), for CCAPI live view and the rear-screen frame.
        for (path in listOf(c.endpoint("shooting/liveview/flip")!!, "/sim/frame?w=600")) {
            val n = 10
            var total = 0L
            var inSim = 0L
            var bytes = 0
            repeat(n) {
                val t0 = System.nanoTime()
                val res = sim.transport.request("GET", path, null, emptyMap())
                total += (System.nanoTime() - t0) / 1_000_000
                inSim += res.header("x-sim-ms")!!.toLong()
                assertJpeg(res.body, path)
                bytes += res.body.size
            }
            log("Frame $path: ${total / n} ms average round trip, ${inSim / n} ms in the simulator, ${bytes / n / 1024} KB")
        }

        // Aperture: some other value the camera offers.
        val av = c.setting("av")
        val options = (av.ability as Ability.Options).values
        val target = options.first { it != av.text && it != options.first() }
        timed("set av $target") { c.set("av", target) }
        assertEquals(target, c.setting("av").text)

        // A shot: the new file comes through event polling, then the download.
        c.poll() // clear what's pending
        val path = timed("shot (shutter + new file)") {
            c.shutter(false)
            c.waitForNewFile(20_000)
        }
        val jpeg = timed("download $path") { c.download(path) }
        assertJpeg(jpeg, "downloaded shot")
        log("Shot: ${jpeg.size / 1024} KB")
    }

    @Test
    fun switchesScenes() = runBlocking<Unit> {
        val scenes = sim.scenes()
        assertTrue(scenes.isNotEmpty())
        assertTrue(scenes.all { it.title.isNotEmpty() && it.goals.isNotEmpty() })
        // Every scene the bundled simulator knows has its images in the APK, and the other way round
        // (catches a host bundle that wasn't rebuilt after scenes were added).
        val folders = context.assets.list("sim/scenes")!!.filter { !it.contains('.') }.toSet()
        assertEquals(folders, scenes.map { it.id }.toSet())
        for (s in scenes) assertJpeg(sim.thumbnail(s.id), "thumbnail ${s.id}")

        val first = sim.scene()
        assertTrue(scenes.any { it.id == first })
        val other = scenes.first { it.id != first }.id
        timed("setScene($other)") { sim.setScene(other) }
        assertEquals(other, sim.scene())
        val c = CcapiClient(sim.transport)
        c.discover()
        c.startLiveView()
        assertJpeg(c.liveFrame(), "live frame in $other")
        try {
            sim.setScene("no-such-scene")
            fail("expected a rejection")
        } catch (_: IllegalArgumentException) {
        }
    }

    /** The page is never on screen: its timers (and the worker's, which the camera waits on) must keep time. */
    @Test
    fun timersKeepRunningOffScreen() = runBlocking<Unit> {
        val res = sim.transport.request("GET", "/host/timing", null, emptyMap())
        val text = res.body.decodeToString()
        log("Timing: $text")
        val o = CcapiClient.json.parseToJsonElement(text) as kotlinx.serialization.json.JsonObject
        val worker = (o["workerTimerLateMs"] as kotlinx.serialization.json.JsonArray).map { it.toString().toInt() }
        assertTrue("worker timers late: $worker", worker.all { it < 200 })
    }

    @Test
    fun closeStopsRequests() = runBlocking<Unit> {
        val c = CcapiClient(sim.transport)
        c.discover()
        sim.close()
        try {
            c.discover()
            fail("expected an IOException")
        } catch (_: IOException) {
        }
        // And it comes back.
        sim.start()
        assertNotEquals(0, sim.scenes().size)
    }
}
