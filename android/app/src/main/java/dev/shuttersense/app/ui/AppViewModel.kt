package dev.shuttersense.app.ui

import android.app.Application
import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.shuttersense.app.agent.AgentRun
import dev.shuttersense.app.agent.AndroidImageTools
import dev.shuttersense.app.agent.CameraTools
import dev.shuttersense.app.agent.DEFAULT_MAX_SHOTS
import dev.shuttersense.app.agent.Idea
import dev.shuttersense.app.agent.Outcome
import dev.shuttersense.app.agent.PrefsPresetStore
import dev.shuttersense.app.agent.Preset
import dev.shuttersense.app.agent.RunOptions
import dev.shuttersense.app.agent.RunUi
import dev.shuttersense.app.agent.ShotResult
import dev.shuttersense.app.agent.StepEntry
import dev.shuttersense.app.agent.StepKind
import dev.shuttersense.app.agent.WorkerClient
import dev.shuttersense.app.audio.Recorder
import dev.shuttersense.app.ccapi.CameraAddress
import dev.shuttersense.app.ccapi.CameraDiscovery
import dev.shuttersense.app.ccapi.CameraHttp
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.ccapi.CcapiException
import dev.shuttersense.app.ccapi.FoundCamera
import dev.shuttersense.app.glasses.GlassesRoom
import dev.shuttersense.app.glasses.HudGuide
import dev.shuttersense.app.glasses.HudState
import dev.shuttersense.app.glasses.RoomListener
import dev.shuttersense.app.glasses.RoomState
import dev.shuttersense.app.glasses.shotReply
import dev.shuttersense.app.net.CameraWifi
import dev.shuttersense.app.net.Networks
import dev.shuttersense.app.service.SessionService
import dev.shuttersense.app.sim.SimScene
import dev.shuttersense.app.sim.SimulatedCamera
import dev.shuttersense.app.ui.camera.ManualCamera
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID
import javax.net.ssl.SSLException

sealed class CameraStatus {
    data object Disconnected : CameraStatus()
    data object Connecting : CameraStatus()
    data class Connected(val name: String, val model: String, val lens: String?) : CameraStatus()
    data class Failed(val message: String) : CameraStatus()
}

class Question(val text: String, val options: List<String>, val answer: CompletableDeferred<String>)
class ShotApproval(val n: Int, val reason: String, val answer: CompletableDeferred<Boolean>)

/** A picture for before / after, as a JPEG data URL (decoded where it is shown, off the main thread). */
class ShotThumb(val n: Int, val image: String, val exposure: String)

enum class Tab { AGENT, CAMERA }

/** Before the main screens: choosing demo or own camera, or connecting one. */
enum class Setup { CHOOSE, CAMERA }

/** Shown as the camera's name in demo mode. */
const val DEMO_CAMERA = "Demo camera"

/** Ready-made goals, the three demo goals first. */
val EXAMPLE_GOALS = listOf(
    "Shoot silently, but get rid of the dark stripes",
    "Sharp shot of the dog, background blurred",
    "Low light indoors: get a sharp, natural-looking shot",
    "Make it moody",
)

const val DEFAULT_WORKER = "https://shuttersense.pages.dev"
const val EMULATOR_WORKER = "http://10.0.2.2:8790"

class AppViewModel(app: Application) : AndroidViewModel(app), RoomListener {
    private val prefs = app.getSharedPreferences("shutter-sense", Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- settings (persisted)
    var host by mutableStateOf(prefs.getString("host", "") ?: "")
    var port by mutableStateOf(prefs.getString("port", "8080") ?: "8080")
    var https by mutableStateOf(prefs.getBoolean("https", false))
    var username by mutableStateOf(prefs.getString("user", "") ?: "")
    var password by mutableStateOf(prefs.getString("pass", "") ?: "")
    var workerUrl by mutableStateOf(prefs.getString("worker", DEFAULT_WORKER) ?: DEFAULT_WORKER)
    var askBeforeShooting by mutableStateOf(prefs.getBoolean("ask", false))
    var maxShots by mutableStateOf(prefs.getInt("maxShots", DEFAULT_MAX_SHOTS))
    var welcomeSeen by mutableStateOf(prefs.getBoolean("welcomeSeen", false))
        private set
    private val session = prefs.getString("session", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("session", it).apply() }

    // ---------------------------------------------------------------- presets
    private val presetStore = PrefsPresetStore(prefs)

    /** The photographer's saved presets (the agent saves them with save_preset), oldest first. */
    val presets = mutableStateListOf<Preset>().apply { addAll(presetStore.list()) }
    var showPresets by mutableStateOf(false)

    // ---------------------------------------------------------------- navigation
    /** The welcome pages, on first launch or from About. */
    var showWelcome by mutableStateOf(!welcomeSeen)
        private set

    /** Past the connect screen: the agent and camera screens. */
    var inMain by mutableStateOf(false)
        private set
    var tab by mutableStateOf(Tab.AGENT)

    /** The last way in ("demo" or "camera"), remembered for the next launch. */
    var lastChoice by mutableStateOf(prefs.getString("choice", null))
        private set
    // Each launch starts at the choice between the demo and a camera; the last one used is marked there.
    var setup by mutableStateOf(Setup.CHOOSE)
        private set

    // ---------------------------------------------------------------- demo
    /** Connected to the camera simulated on this phone. */
    var demo by mutableStateOf(false)
        private set
    var demoStarting by mutableStateOf(false)
        private set
    val scenes = mutableStateListOf<SimScene>()
    var sceneId by mutableStateOf<String?>(null)
        private set
    val sceneThumbs = mutableStateMapOf<String, ImageBitmap>()
    var switchingScene by mutableStateOf(false)
        private set
    private var simulator: SimulatedCamera? = null
    private val sim: SimulatedCamera
        get() = simulator ?: SimulatedCamera(getApplication<Application>().applicationContext).also { simulator = it }

    /** Goal suggestions: the demo scene's own, or the general ones. */
    val exampleGoals: List<String>
        get() = scenes.firstOrNull { it.id == sceneId }?.goals?.takeIf { demo && it.isNotEmpty() } ?: EXAMPLE_GOALS

    // ---------------------------------------------------------------- run state
    var camera by mutableStateOf<CameraStatus>(CameraStatus.Disconnected)
        private set

    /** Manual control of the connected camera (the Camera screen). */
    var manual by mutableStateOf<ManualCamera?>(null)
        private set

    /** Cameras found on the network by SSDP. */
    val found = mutableStateListOf<FoundCamera>()
    var searching by mutableStateOf(false)
        private set
    var goal by mutableStateOf("")
    val steps = mutableStateListOf<StepEntry>()
    var status by mutableStateOf("")
        private set
    var exposure by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var firstShot by mutableStateOf<ShotThumb?>(null)
        private set

    /** The first live view taken before the agent changed anything: the camera's own idea of the shot. */
    var beforeView by mutableStateOf<ShotThumb?>(null)
        private set
    private var settingsTouched = false
    var lastShot by mutableStateOf<ShotThumb?>(null)
        private set
    var question by mutableStateOf<Question?>(null)
        private set
    var approval by mutableStateOf<ShotApproval?>(null)
        private set
    var recording by mutableStateOf(false)
        private set
    var transcribing by mutableStateOf(false)
        private set
    var notice by mutableStateOf<String?>(null)

    // ---------------------------------------------------------------- glasses
    var roomState by mutableStateOf(RoomState.OFF)
        private set
    var glassesOnline by mutableStateOf(0)
        private set
    /** A glasses session exists (pairing or paired); it lives until the app closes or the server expires it. */
    var glassesSession by mutableStateOf(false)
        private set
    var pattern by mutableStateOf<String?>(null)
        private set
    var patternExpires by mutableStateOf(0L)
        private set
    var showGlasses by mutableStateOf(false)

    private var tools: CameraTools? = null
    private var run: AgentRun? = null
    private var room: GlassesRoom? = null
    private var hud = HudState()
    private var recorder: Recorder? = null

    /** Work tied to the current camera (connecting, scene switches, manual control); [disconnect] cancels it. */
    private var cameraScope = newCameraScope()

    private fun newCameraScope() = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job]))

    private var workerClient: WorkerClient? = null
    private val worker: WorkerClient
        get() = workerClient?.takeIf { it.base == workerUrl.trim().trimEnd('/') } ?: WorkerClient(workerUrl).also { workerClient = it }

    init {
        presetStore.onChange = {
            presets.clear()
            presets.addAll(presetStore.list())
        }
        Networks.init(app)
        // Keep running with the screen locked while there's a camera, an agent run or a glasses session.
        viewModelScope.launch {
            snapshotFlow { sessionText() }.distinctUntilChanged().collect { text ->
                if (text == null) SessionService.hide(app) else SessionService.show(app, text)
            }
        }
    }

    fun finishWelcome() {
        welcomeSeen = true
        showWelcome = false
        prefs.edit().putBoolean("welcomeSeen", true).apply()
    }

    private fun rememberChoice(choice: String) {
        lastChoice = choice
        prefs.edit().putString("choice", choice).apply()
    }

    /** Back to choosing between the demo and a camera (drops the current connection). */
    fun openChooser() {
        disconnect()
        setup = Setup.CHOOSE
    }

    /** "Connect my camera": the connect screen. */
    fun chooseCamera() {
        rememberChoice("camera")
        setup = Setup.CAMERA
    }

    /** "Try the demo": starts the simulated camera and goes straight to the main screens. */
    fun startDemo() {
        if (demoStarting) return
        rememberChoice("demo")
        saveSettings()
        run?.cancel()
        demoStarting = true
        cameraScope.launch {
            try {
                sim.start()
                val t = CameraTools(CcapiClient(sim.transport), AndroidImageTools())
                t.connect()
                attach(t, demo = true)
                inMain = true
                loadScenes()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setup = Setup.CHOOSE
                notice = "The demo camera couldn't start: ${e.message ?: e.javaClass.simpleName}"
            } finally {
                demoStarting = false
            }
        }
    }

    private suspend fun loadScenes() {
        try {
            val list = sim.scenes()
            scenes.clear()
            scenes.addAll(list)
            sceneId = sim.scene()
            for (sc in list) {
                if (sc.id in sceneThumbs) continue
                try {
                    val bytes = sim.thumbnail(sc.id)
                    withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
                        ?.let { sceneThumbs[sc.id] = it }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // the picker shows the title alone
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // no scene list: the switcher stays hidden
        }
    }

    /** Demo mode: switches the simulated scene and starts a fresh conversation. */
    fun selectScene(id: String) {
        if (!demo || busy || switchingScene || id == sceneId) return
        switchingScene = true
        cameraScope.launch {
            try {
                sim.setScene(id)
                sceneId = id
                newGoal()
                tools?.let {
                    it.refresh()
                    exposure = it.exposureLine()
                }
                manual?.reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = "Couldn't switch the scene: ${e.message}"
            } finally {
                switchingScene = false
            }
        }
    }

    /** Wires a connected camera to the agent and to manual control. */
    private fun attach(t: CameraTools, demo: Boolean) {
        tools = t
        this.demo = demo
        exposure = t.exposureLine()
        recreateRun()
        // Nothing from a camera that has since been replaced.
        manual = ManualCamera(t, cameraScope, onExposure = { if (tools === t) exposure = it }, onNotice = { if (tools === t) notice = it })
        camera = CameraStatus.Connected(if (demo) DEMO_CAMERA else t.describe(), if (demo) DEMO_CAMERA else t.modelName, t.lens)
    }

    fun openWelcome() {
        showWelcome = true
    }

    /** Leaves the connect screen once the camera is connected. */
    fun enterMain() {
        if (camera is CameraStatus.Connected) inMain = true
    }

    fun saveSettings() {
        prefs.edit()
            .putString("host", host.trim()).putString("port", port.trim()).putBoolean("https", https)
            .putString("user", username).putString("pass", password)
            .putString("worker", workerUrl.trim()).putBoolean("ask", askBeforeShooting).putInt("maxShots", maxShots)
            .apply()
    }

    // ---------------------------------------------------------------- camera

    fun connect() {
        saveSettings()
        val h = host.trim()
        if (h.isEmpty()) {
            camera = CameraStatus.Failed("Enter the camera's IP address")
            return
        }
        run?.cancel()
        camera = CameraStatus.Connecting
        cameraScope.launch {
            try {
                val address = CameraAddress(h, port.trim().toIntOrNull() ?: 8080, https, username, password)
                val t = CameraTools(CcapiClient(CameraHttp.transport(address)), AndroidImageTools())
                t.connect()
                attach(t, demo = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                camera = CameraStatus.Failed(connectError(e, "$h:${port.trim().ifEmpty { "8080" }}"))
            }
        }
    }

    fun disconnect() {
        // A connection still being made, a scene switch, manual shots: all for the camera that's going.
        cameraScope.cancel()
        cameraScope = newCameraScope()
        // Stop the simulator (it would keep running in the background); a demo still starting gives up too.
        simulator?.close()
        dropRun()
        tools = null
        manual = null
        inMain = false
        demo = false
        clearConversation()
        hud = HudState()
        pushHud()
        exposure = null
        camera = CameraStatus.Disconnected
    }

    /** Fills the form from a camera found on the network and connects. */
    fun useFound(c: FoundCamera) {
        host = c.host
        port = c.port.toString()
        https = c.https
        connect()
    }

    // ---------------------------------------------------------------- the camera's own Wi-Fi

    /** The camera network joined for this app only, if any. */
    var cameraWifi by mutableStateOf(CameraWifi.ssid)
        private set
    var joiningWifi by mutableStateOf<String?>(null)
        private set
    var wifiError by mutableStateOf<String?>(null)
        private set
    var wifiName by mutableStateOf(prefs.getString("wifiName", "") ?: "")

    /** Joins the camera's Wi-Fi for this app (Android asks to confirm), then looks for the camera on it. */
    fun joinWifi(passphrase: String) {
        val name = wifiName.trim()
        if (joiningWifi != null || name.isEmpty()) return
        prefs.edit().putString("wifiName", name).apply()
        joiningWifi = name
        wifiError = null
        viewModelScope.launch {
            val ok = try {
                withTimeoutOrNull(90_000) { CameraWifi.join(getApplication(), name, passphrase) } ?: false
            } catch (_: Exception) {
                false
            }
            joiningWifi = null
            if (!ok) {
                CameraWifi.leave(getApplication())
                wifiError = "Couldn't join $name. Check the name and password, and confirm Android's prompt."
                return@launch
            }
            cameraWifi = name
            // On its own access point the camera hands out the addresses: connect to it straight away.
            val address = CameraWifi.cameraAddress(getApplication())
            if (address != null) {
                host = address
                port = "8080"
                connect()
            } else searchCameras()
        }
    }

    fun leaveWifi() {
        CameraWifi.leave(getApplication())
        cameraWifi = null
        found.clear()
    }

    /** Looks for cameras on the Wi-Fi (SSDP). */
    fun searchCameras() {
        if (searching) return
        searching = true
        viewModelScope.launch {
            try {
                val list = CameraDiscovery.search(getApplication())
                found.clear()
                found.addAll(list)
            } catch (_: Exception) {
                // no network: the list stays empty and manual entry works
            } finally {
                searching = false
            }
        }
    }

    // ---------------------------------------------------------------- agent

    private fun startGoal(text: String) {
        if (manual?.busy == true) {
            notice = "Wait for the shot to finish"
            return
        }
        saveSettings()
        clearConversation()
        hud = HudState(phase = "working", goal = text.trim(), shotsMax = maxShots)
        recreateRun()
        run?.start(text)
        goal = ""
        busy = true
    }

    /**
     * Cancels the current run and forgets it. Its last reports (the cancel,
     * the end) are dropped, so what they would have reset is reset here.
     */
    private fun dropRun() {
        run?.cancel()
        run = null
        busy = false
        status = ""
        question = null
        approval = null
    }

    /** A fresh run picks up the current toggles (ask before shooting, max shots). */
    private fun recreateRun() {
        dropRun()
        val t = tools ?: return
        val ui = RunCallbacks()
        run = AgentRun(worker, t, ui, RunOptions(maxShots, askBeforeShooting, { glassesOnline > 0 }, session, presetStore), viewModelScope)
            .also { ui.owner = it }
    }

    /** Sends the goal box: a new goal when idle, a correction while working or after a finished run. */
    fun submit() {
        val r = run
        val t = goal.trim()
        if (t.isEmpty()) return
        if (r == null) {
            notice = "Connect a camera first"
            return
        }
        if (r.busy || started) {
            // Working, or a correction to the finished shot.
            if (!r.busy) hud = hud.copy(phase = "working", summary = null)
            r.instruct(t)
            goal = ""
            busy = r.busy
        } else startGoal(t)
    }

    /** The input bar: answers an open question or shot approval, else a goal or a correction. */
    fun send() {
        val t = goal.trim()
        if (t.isEmpty()) return
        if (question != null || approval != null) goal = ""
        route(t)
    }

    /**
     * Where typed, spoken and dictated input goes: the answer to an open
     * question, a reply to an open shot approval, else a goal or a correction.
     */
    private fun route(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        when {
            question != null -> answer(t)
            approval != null -> when (shotReply(t)) {
                true -> approve(true)
                false -> approve(false)
                null -> {
                    // A correction ("make it warmer first"): queued before the skip, so the next round sees it.
                    goal = t
                    submit()
                    approve(false)
                }
            }
            else -> {
                goal = t
                submit()
            }
        }
    }

    /** "Use" on a saved preset: asks the agent to apply it, the same way a typed goal or correction goes. */
    fun usePreset(p: Preset) = route("Apply my preset \"${p.name}\"")

    fun deletePreset(p: Preset) = presetStore.remove(p.name)

    /** A tapped picture idea: tells the agent which one to go with. */
    fun tryIdea(idea: Idea) = route(if (idea.direction.isNotEmpty()) "Let's try \"${idea.title}\": ${idea.direction}" else "Let's try \"${idea.title}\"")

    /** Whether a goal has been given in this conversation (corrections then refine it). */
    val started: Boolean get() = steps.any { it.kind == StepKind.GOAL }

    fun newGoal() {
        clearConversation()
        hud = HudState()
        pushHud()
        recreateRun()
    }

    fun cancel() = run?.cancel()

    private fun clearConversation() {
        steps.clear()
        firstShot = null
        lastShot = null
        beforeView = null
        settingsTouched = false
    }

    fun answer(text: String) {
        question?.answer?.complete(text)
        question = null
    }

    fun approve(ok: Boolean) {
        approval?.answer?.complete(ok)
        approval = null
    }

    // ---------------------------------------------------------------- RunUi

    /**
     * The screen side of one run. A replaced run (a new goal, a scene switch,
     * another camera) is cancelled but still unwinds for a moment; what it
     * reports then is dropped, so it can't land in the next conversation.
     */
    private inner class RunCallbacks : RunUi {
        lateinit var owner: AgentRun
        private val live: Boolean get() = run === owner

        override fun step(entry: StepEntry) {
            if (!live) return
            steps.add(entry)
            if (entry.kind == StepKind.SETTINGS && entry.detail.isNotEmpty()) settingsTouched = true
            if (entry.kind == StepKind.LOOK && beforeView == null && !settingsTouched) {
                entry.image?.let { beforeView = ShotThumb(0, it, "Camera's settings") }
            }
            busy = owner.busy
            when (entry.kind) {
                StepKind.TELL -> hud = hud.copy(message = entry.text)
                StepKind.GOAL -> hud = hud.copy(goal = entry.text)
                // The ideas stay on the lens to flip through until the next goal.
                StepKind.IDEAS -> if (entry.ideas.isNotEmpty()) hud = hud.copy(ideas = entry.ideas)
                else -> {}
            }
            // The menu path stays on the lens while its question is open, and goes with the next step.
            hud = when (entry.kind) {
                StepKind.GUIDE -> hud.copy(guide = HudGuide(entry.title.orEmpty(), entry.detail, entry.menu))
                StepKind.ASK, StepKind.ANSWER -> hud
                else -> hud.copy(guide = null)
            }
            pushHud()
        }

        override fun status(text: String) {
            if (!live) return
            status = text
            busy = owner.busy
            hud = hud.copy(step = text.ifEmpty { hud.step }, phase = if (text.isNotEmpty()) "working" else hud.phase)
            pushHud()
        }

        override fun shot(result: ShotResult) {
            if (!live) return
            if (result.thumb.isNotEmpty()) {
                val t = ShotThumb(result.n, result.thumb, result.exposure)
                if (firstShot == null) firstShot = t
                lastShot = t
            }
            hud = hud.copy(thumb = result.thumb, shotsTaken = result.n, shotsMax = owner.shotBudget)
            pushHud()
        }

        override fun exposure(line: String, diff: List<String>) {
            if (!live) return
            exposure = line
            hud = hud.copy(exposure = line, diff = if (diff.isNotEmpty()) diff else hud.diff)
            pushHud()
        }

        override suspend fun confirmShot(n: Int, reason: String): Boolean {
            if (!live) return false
            val a = ShotApproval(n, reason, CompletableDeferred())
            approval = a
            hud = hud.copy(phase = "asking", question = "Take shot $n?", options = listOf("Shoot", "Skip"))
            pushHud()
            return try {
                a.answer.await()
            } finally {
                if (approval === a) approval = null
                if (live) {
                    hud = hud.copy(phase = "working", question = null, options = emptyList())
                    pushHud()
                }
            }
        }

        override suspend fun ask(question: String, options: List<String>): String {
            if (!live) throw CancellationException("The run was replaced")
            val q = Question(question, options, CompletableDeferred())
            this@AppViewModel.question = q
            hud = hud.copy(phase = "asking", question = question, options = options)
            pushHud()
            return try {
                q.answer.await()
            } finally {
                if (this@AppViewModel.question === q) this@AppViewModel.question = null
                if (live) {
                    hud = hud.copy(phase = "working", question = null, options = emptyList())
                    pushHud()
                }
            }
        }

        override suspend fun handSet(setting: String, value: String) {
            // Only the demo camera learns it this way; a real camera has it set already.
            val s = simulator?.takeIf { demo && live } ?: return
            try {
                s.menu(setting, value)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // an older simulator without menu settings: nothing changes in the picture
            }
        }

        override fun ended(outcome: Outcome, summary: String?, lens: String?) {
            if (!live) return
            busy = false
            status = ""
            hud = hud.copy(
                phase = when (outcome) {
                    Outcome.DONE -> "done"
                    Outcome.CANCELLED -> "idle"
                    Outcome.ERROR -> "error"
                },
                step = when (outcome) {
                    Outcome.DONE -> "Done"
                    Outcome.CANCELLED -> "Cancelled"
                    Outcome.ERROR -> steps.lastOrNull()?.text ?: "Error"
                },
                summary = lens ?: hud.summary,
                question = null,
                options = emptyList(),
            )
            pushHud()
        }
    }

    // ---------------------------------------------------------------- voice

    fun toggleRecording() {
        if (recording) stopRecording() else startRecording()
    }

    /** Records until the second tap (or the time limit), then transcribes and sends what was said. */
    private fun startRecording() {
        val r = Recorder()
        recorder = r
        recording = true
        viewModelScope.launch {
            val wav = try {
                r.record()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = e.message ?: "Couldn't record"
                null
            } finally {
                // Unless a new recording has started meanwhile.
                if (recorder === r) {
                    recording = false
                    recorder = null
                }
            }
            if (wav != null) transcribe(wav)
        }
    }

    private fun stopRecording() {
        recorder?.stop()
        recording = false
    }

    private suspend fun transcribe(wav: ByteArray) {
        transcribing = true
        try {
            val text = worker.transcribe(wav)
            if (text.isBlank()) notice = "Didn't catch that. Try again."
            else route(text)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            notice = e.message ?: "Transcription failed"
        } finally {
            transcribing = false
        }
    }

    // ---------------------------------------------------------------- glasses

    fun openGlasses() {
        saveSettings()
        showGlasses = true
        val r = room
        if (r != null) {
            r.requestPairing()
            return
        }
        // A second tap while the session is being created doesn't make another one.
        if (creatingRoom?.isActive == true) return
        creatingRoom = viewModelScope.launch {
            try {
                val w = worker
                val s = w.createSession()
                room = GlassesRoom(w, s.code, s.token, viewModelScope, this@AppViewModel).also {
                    it.start()
                    it.sendHud(hud)
                }
                glassesSession = true
                // Ask for a pattern once the socket is up.
                pendingPair = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = "Couldn't start a glasses session: ${e.message}"
                showGlasses = false
            }
        }
    }

    private var pendingPair = false
    private var creatingRoom: Job? = null

    override fun onState(state: RoomState, glasses: Int) {
        viewModelScope.launch {
            roomState = state
            glassesOnline = glasses
            if (state == RoomState.ONLINE && pendingPair) {
                pendingPair = false
                room?.requestPairing()
            }
        }
    }

    override fun onPairing(pattern: String?, expiresInMs: Long) {
        viewModelScope.launch {
            this@AppViewModel.pattern = pattern
            patternExpires = if (pattern != null) System.currentTimeMillis() + expiresInMs else 0
            if (pattern == null) notice = "Glasses paired"
        }
    }

    override fun onSay(text: String) {
        viewModelScope.launch { route(text) }
    }

    override fun onGone() {
        viewModelScope.launch {
            // The room expired on the server: drop it, so the glasses button makes a fresh one.
            room?.stop()
            room = null
            // An open pairing sheet would otherwise wait for a session that isn't coming.
            showGlasses = false
            glassesSession = false
            glassesOnline = 0
            pendingPair = false
            pattern = null
            patternExpires = 0
            notice = "Glasses session expired"
        }
    }

    private fun pushHud() {
        room?.sendHud(hud)
    }

    /** What the ongoing notification says, or null when nothing needs the app to keep running. */
    fun sessionText(): String? {
        if (!inMain && !glassesSession) return null
        val parts = mutableListOf<String>()
        if (inMain) parts += if (demo) "Demo camera" else ((camera as? CameraStatus.Connected)?.model ?: "Camera")
        if (glassesSession) parts += if (glassesOnline > 0) "glasses connected" else "glasses pairing"
        if (busy) parts += "agent working"
        return parts.joinToString(" \u00b7 ")
    }

    override fun onCleared() {
        SessionService.hide(getApplication())
        run?.cancel()
        simulator?.close()
        CameraWifi.leave(getApplication())
        room?.stop()
    }
}

/** A reason a person can act on, for the connect screen. */
fun connectError(e: Exception, where: String): String {
    var cause: Throwable? = e
    while (cause != null) {
        when (cause) {
            is UnknownHostException -> return "There's no device called $where on this network. Check the address."
            is ConnectException, is NoRouteToHostException ->
                return "Nothing answered at $where. Is the camera on, on this Wi-Fi, with remote control (CCAPI) enabled?"
            is SocketTimeoutException -> return "The camera at $where didn't answer in time. Move closer to the Wi-Fi or check the address."
            is SSLException -> return "A secure (HTTPS) connection couldn't be made. Switch HTTPS to match the camera's setting."
            is CcapiException -> return when (cause.status) {
                401 -> "The camera asked for a login. Check the username and password under Advanced."
                403 -> "The camera refused the connection. Check the login under Advanced."
                404 -> "Something answered at $where, but it isn't a camera with CCAPI. Check the port."
                503 -> "The camera is busy. Close any other remote app and try again."
                else -> "The camera answered with an error: ${cause.message}"
            }
        }
        cause = cause.cause
    }
    return "Couldn't connect: ${e.message ?: e.javaClass.simpleName}"
}
