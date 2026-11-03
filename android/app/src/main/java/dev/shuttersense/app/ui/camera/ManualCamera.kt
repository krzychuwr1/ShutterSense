package dev.shuttersense.app.ui.camera

import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import dev.shuttersense.app.agent.CameraTools
import dev.shuttersense.app.ccapi.Ability
import dev.shuttersense.app.ccapi.CameraValues
import dev.shuttersense.app.ccapi.CcapiException
import dev.shuttersense.app.ccapi.LiveViewInfo
import dev.shuttersense.app.ccapi.SettingException
import dev.shuttersense.app.ccapi.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.math.max

// Manual control for the Camera screen: a live view loop, the exposure dials
// built from the camera's option lists, tap-to-focus and the shutter. Uses the
// same CameraTools as the agent (never at the same time: the screen pauses
// while a run is going), with one lock so a shot never races a live frame.

/** One exposure dial: what it is set to, what it could be set to. */
data class Dial(
    val key: String,
    val label: String,
    /** The raw value ("f5.6"), or "" when the camera chooses it. */
    val value: String,
    val options: List<String>,
    /** Whether it can be changed in the current mode. */
    val changeable: Boolean,
    /** The value the camera picked, for dials it controls (or for ISO auto). */
    val chosen: String?,
)

class ManualShot(val image: ImageBitmap, val exposure: String, val n: Int)

/** Dials shown, in order. */
private val DIALS = listOf("shootingmode" to "Mode", "av" to "Aperture", "tv" to "Shutter", "iso" to "ISO", "exposure" to "Exp")

/** Live frames per second at most; the camera usually sets the real pace. */
private const val FRAME_GAP_MS = 120L

/** How often settings and camera-chosen values are re-read while live view runs. */
private const val REFRESH_MS = 4000L

class ManualCamera(
    private val tools: CameraTools,
    private val scope: CoroutineScope,
    private val onExposure: (String) -> Unit,
    private val onNotice: (String) -> Unit,
) {
    private val lock = Mutex()
    private var sensor: Pair<Int, Int>? = null
    private var shots = 0

    var frame by mutableStateOf<ImageBitmap?>(null)
        private set
    var liveError by mutableStateOf<String?>(null)
        private set
    var dials by mutableStateOf(buildDials(tools.settings))
        private set

    /** The AF point as fractions of the frame, or null before it is known. */
    var afPoint by mutableStateOf<Offset?>(null)
        private set
    var focusing by mutableStateOf(false)
        private set

    /** The dial whose change is being applied. */
    var applying by mutableStateOf<String?>(null)
        private set
    var shooting by mutableStateOf(false)
        private set
    var lastShot by mutableStateOf<ManualShot?>(null)
        private set
    var afOnShutter by mutableStateOf(true)

    /** Luminance histogram of the live view (256 bins), when the camera sends one. */
    var histogram by mutableStateOf<IntArray?>(null)
        private set

    /** Frames received, so the screen can tell a live picture from a stale one. */
    var frames by mutableIntStateOf(0)
        private set

    val busy: Boolean get() = shooting || applying != null

    val exposureLine: String get() = tools.exposureLine()

    /**
     * Fetches live frames until the calling coroutine is cancelled (the screen
     * leaves, the app goes to the background, or an agent run starts).
     */
    suspend fun runLiveView() {
        if (sensor == null) loadInfo()
        var fails = 0
        var refreshed = System.currentTimeMillis()
        // Frame and incidental information in one request where the camera offers it.
        var detailed = tools.client.has("shooting/liveview/flipdetail")
        while (currentCoroutineContext().isActive) {
            try {
                val jpeg = if (detailed) {
                    val d = lock.withLock { tools.client.liveFrameWithInfo() }
                    d.info?.let(::absorb)
                    d.image ?: run {
                        // Information but no picture: fall back to plain frames.
                        detailed = false
                        lock.withLock { tools.client.liveFrame() }
                    }
                } else lock.withLock { tools.client.liveFrame() }
                val bmp = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.asImageBitmap() }
                if (bmp != null) {
                    frame = bmp
                    frames++
                }
                liveError = null
                fails = 0
                if (System.currentTimeMillis() - refreshed > REFRESH_MS) {
                    refreshed = System.currentTimeMillis()
                    lock.withLock { tools.refresh() }
                    update()
                }
                delay(FRAME_GAP_MS)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fails++
                liveError = when {
                    e is CcapiException && e.status == 503 -> "The camera is busy"
                    e is CcapiException && e.status == 404 -> "This camera has no live view over the network"
                    else -> "Live view lost. Retrying…"
                }
                delay(minOf(4000L, 400L * fails))
            }
        }
    }

    /** Histogram and AF frame from a frame's incidental information. */
    private fun absorb(info: LiveViewInfo) {
        info.histogram?.firstOrNull()?.takeIf { it.size >= 64 }?.let { histogram = it }
        info.sensorSize?.let { sensor = it }
        val (w, h) = sensor ?: return
        if (focusing || w <= 0 || h <= 0) return
        val f = info.afFrames.firstOrNull { it.select == 1 } ?: info.afFrames.firstOrNull() ?: return
        if (f.width > 0) afPoint = Offset((f.x + f.width / 2f) / w, (f.y + f.height / 2f) / h)
    }

    /** Sensor size (for the AF point) and where the AF frame is now. */
    private suspend fun loadInfo() {
        try {
            val info = lock.withLock { tools.client.liveDetail("info").info } ?: return
            sensor = info.sensorSize
            val (w, h) = sensor ?: return
            val f = info.afFrames.firstOrNull { it.select == 1 } ?: info.afFrames.firstOrNull() ?: return
            if (w > 0 && h > 0) afPoint = Offset((f.x + f.width / 2f) / w, (f.y + f.height / 2f) / h)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // no incidental information: tap-to-focus still works through focusAt
        }
    }

    /** The camera changed underneath (a demo scene switch): forget the picture and re-read everything. */
    suspend fun reload() {
        frame = null
        histogram = null
        afPoint = null
        sensor = null
        lastShot = null
        lock.withLock { tools.refresh() }
        update()
    }

    /** Sets one dial. */
    fun select(key: String, value: String) {
        val dial = dials.firstOrNull { it.key == key } ?: return
        if (!dial.changeable || dial.value == value || busy) return
        applying = key
        // Show the new value straight away; the camera's answer corrects it.
        dials = dials.map { if (it.key == key) it.copy(value = value) else it }
        scope.launch {
            try {
                lock.withLock {
                    val item = if (key == "shootingmode") null else tools.settings[key]
                    tools.client.set(key, value, item)
                    tools.refresh()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: SettingException) {
                onNotice(e.message ?: "The camera refused that")
            } catch (e: Exception) {
                onNotice("Couldn't change ${dial.label.lowercase()}: ${e.message}")
                runCatching { lock.withLock { tools.refresh() } }
            } finally {
                applying = null
                update()
            }
        }
    }

    /** Puts the AF point at a spot on the live view (fractions from the top left). */
    fun focus(x: Float, y: Float) {
        if (busy || focusing) return
        val before = afPoint
        afPoint = Offset(x, y)
        focusing = true
        scope.launch {
            try {
                val (applied, _) = lock.withLock { tools.focusAt(x.toDouble(), y.toDouble()) }
                // Tracking AF ignores the point, so focusAt may have switched the AF area first.
                if (applied.size > 1) onNotice(applied[0])
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                afPoint = before
                onNotice(e.message?.replaceFirstChar { it.uppercase() } ?: "Couldn't move the AF point")
            } finally {
                focusing = false
                update()
            }
        }
    }

    /** Takes a picture and keeps a display-size copy for the thumbnail and the viewer. */
    fun shoot() {
        if (busy) return
        shooting = true
        scope.launch {
            try {
                val r = lock.withLock { tools.shoot(afOnShutter, ++shots) }
                val img = withContext(Dispatchers.Default) { decodeScaled(r.jpeg, 2400) }
                if (img != null) lastShot = ManualShot(img, r.exposure, r.n)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onNotice("The shot failed: ${e.message}")
            } finally {
                shooting = false
                update()
            }
        }
    }

    private fun update() {
        dials = buildDials(tools.settings)
        onExposure(tools.exposureLine())
    }

    private fun buildDials(s: Settings): List<Dial> = DIALS.mapNotNull { (key, label) ->
        if (key == "shootingmode") {
            val item = s["shootingmode"] ?: s["shootingmodedial"] ?: return@mapNotNull null
            val options = (item.ability as? Ability.Options)?.values ?: emptyList()
            val canSet = tools.client.has("shooting/settings/shootingmode", "put") || tools.client.has("shooting/settings/shootingmodedial", "put")
            Dial(key, label, item.text.orEmpty(), options, canSet && options.isNotEmpty(), null)
        } else {
            val item = s[key] ?: return@mapNotNull null
            val options = (item.ability as? Ability.Options)?.values ?: emptyList()
            val value = item.text.orEmpty()
            val chosen = tools.cameraChosen(key)?.takeIf { value.isEmpty() || value == "auto" }
            Dial(key, label, value, options, item.changeable && options.isNotEmpty(), chosen)
        }
    }

    companion object {
        /** A value as short as a dial can show it: "5.6", "1/250", "0.5″", "800", "+⅔". */
        fun short(key: String, v: String): String {
            if (v.isEmpty()) return "–"
            return when (key) {
                "av" -> CameraValues.avNumber(v)?.let { CameraValues.num(it) } ?: v
                "tv" -> if (v.startsWith("1/")) v else CameraValues.tvSeconds(v)?.let { "${CameraValues.num(it)}″" } ?: v
                "iso" -> if (v == "auto") "Auto" else v
                "exposure" -> CameraValues.prettyValue("exposure", v).removeSuffix(" EV")
                "shootingmode" -> CameraValues.prettyValue("shootingmode", v)
                else -> v
            }
        }

        /** The unit a dial's short value leaves out. */
        fun unit(key: String): String = when (key) {
            "av" -> "f/"
            "tv" -> "s"
            "iso" -> "ISO"
            "exposure" -> "EV"
            else -> ""
        }
    }
}

/** Decodes a JPEG with its long side at most about [maxSide]. */
private fun decodeScaled(jpeg: ByteArray, maxSide: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}
