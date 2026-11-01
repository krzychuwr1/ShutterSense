package dev.secondshooter.app.ui

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.secondshooter.app.agent.AgentRun
import dev.secondshooter.app.agent.AndroidImageTools
import dev.secondshooter.app.agent.CameraTools
import dev.secondshooter.app.agent.DEFAULT_MAX_SHOTS
import dev.secondshooter.app.agent.Outcome
import dev.secondshooter.app.agent.RunOptions
import dev.secondshooter.app.agent.RunUi
import dev.secondshooter.app.agent.ShotResult
import dev.secondshooter.app.agent.StepEntry
import dev.secondshooter.app.agent.StepKind
import dev.secondshooter.app.agent.WorkerClient
import dev.secondshooter.app.audio.Recorder
import dev.secondshooter.app.ccapi.CameraAddress
import dev.secondshooter.app.ccapi.CameraHttp
import dev.secondshooter.app.ccapi.CcapiClient
import dev.secondshooter.app.glasses.GlassesRoom
import dev.secondshooter.app.glasses.HudState
import dev.secondshooter.app.glasses.RoomListener
import dev.secondshooter.app.glasses.RoomState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.UUID

sealed class CameraStatus {
    data object Disconnected : CameraStatus()
    data object Connecting : CameraStatus()
    data class Connected(val name: String) : CameraStatus()
    data class Failed(val message: String) : CameraStatus()
}

class Question(val text: String, val options: List<String>, val answer: CompletableDeferred<String>)
class ShotApproval(val n: Int, val reason: String, val answer: CompletableDeferred<Boolean>)
class ShotThumb(val n: Int, val bitmap: Bitmap, val exposure: String)

/** Ready-made goals, the three demo goals first. */
val EXAMPLE_GOALS = listOf(
    "She's backlit, fix it",
    "Sharp shot of the dog, background blurred",
    "Low light indoors: get a sharp, natural-looking shot",
    "Make it moody",
)

const val DEFAULT_WORKER = "https://second-shooter.example.workers.dev"
const val EMULATOR_WORKER = "http://10.0.2.2:8790"

class AppViewModel(app: Application) : AndroidViewModel(app), RunUi, RoomListener {
    private val prefs = app.getSharedPreferences("second-shooter", Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- settings (persisted)
    var host by mutableStateOf(prefs.getString("host", "") ?: "")
    var port by mutableStateOf(prefs.getString("port", "8080") ?: "8080")
    var https by mutableStateOf(prefs.getBoolean("https", false))
    var username by mutableStateOf(prefs.getString("user", "") ?: "")
    var password by mutableStateOf(prefs.getString("pass", "") ?: "")
    var workerUrl by mutableStateOf(prefs.getString("worker", DEFAULT_WORKER) ?: DEFAULT_WORKER)
    var askBeforeShooting by mutableStateOf(prefs.getBoolean("ask", false))
    var maxShots by mutableStateOf(prefs.getInt("maxShots", DEFAULT_MAX_SHOTS))
    private val session = prefs.getString("session", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("session", it).apply() }

    // ---------------------------------------------------------------- run state
    var camera by mutableStateOf<CameraStatus>(CameraStatus.Disconnected)
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
    var pattern by mutableStateOf<String?>(null)
        private set
    var patternExpires by mutableStateOf(0L)
        private set
    var showGlasses by mutableStateOf(false)

    private var tools: CameraTools? = null
    private var run: AgentRun? = null
    private var room: GlassesRoom? = null
    private var hud = HudState()
    private val recorder = Recorder()
    private var recordJob: Job? = null

    private var workerClient: WorkerClient? = null
    private val worker: WorkerClient
        get() = workerClient?.takeIf { it.base == workerUrl.trim().trimEnd('/') } ?: WorkerClient(workerUrl).also { workerClient = it }

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
        viewModelScope.launch {
            try {
                val address = CameraAddress(h, port.trim().toIntOrNull() ?: 8080, https, username, password)
                val t = CameraTools(CcapiClient(CameraHttp.transport(address)), AndroidImageTools())
                val name = t.connect()
                tools = t
                exposure = t.exposureLine()
                run = AgentRun(worker, t, this@AppViewModel, RunOptions(maxShots, askBeforeShooting, { glassesOnline > 0 }, session), viewModelScope)
                camera = CameraStatus.Connected(name)
            } catch (e: Exception) {
                camera = CameraStatus.Failed("Couldn't reach the camera: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }

    fun disconnect() {
        run?.cancel()
        run = null
        tools = null
        camera = CameraStatus.Disconnected
    }

    // ---------------------------------------------------------------- agent

    private fun startGoal(text: String) {
        saveSettings()
        steps.clear()
        firstShot = null
        lastShot = null
        hud = HudState(phase = "working", goal = text.trim(), shotsMax = maxShots)
        recreateRun()
        run?.start(text)
        goal = ""
        busy = true
    }

    /** A fresh run picks up the current toggles (ask before shooting, max shots). */
    private fun recreateRun() {
        val t = tools ?: return
        run = AgentRun(worker, t, this, RunOptions(maxShots, askBeforeShooting, { glassesOnline > 0 }, session), viewModelScope)
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
        if (r.busy || steps.any { it.kind == StepKind.GOAL }) {
            // Working, or a correction to the finished shot.
            if (!r.busy) hud = hud.copy(phase = "working", summary = null)
            r.instruct(t)
            goal = ""
            busy = r.busy
        } else startGoal(t)
    }

    fun newGoal() {
        run?.cancel()
        steps.clear()
        firstShot = null
        lastShot = null
        hud = HudState()
        pushHud()
        recreateRun()
    }

    fun cancel() = run?.cancel()

    fun answer(text: String) {
        question?.answer?.complete(text)
        question = null
    }

    fun approve(ok: Boolean) {
        approval?.answer?.complete(ok)
        approval = null
    }

    // ---------------------------------------------------------------- RunUi

    override fun step(entry: StepEntry) {
        steps.add(entry)
        busy = run?.busy ?: false
        when (entry.kind) {
            StepKind.TELL -> hud = hud.copy(message = entry.text)
            StepKind.DONE -> hud = hud.copy(summary = entry.text)
            StepKind.GOAL -> hud = hud.copy(goal = entry.text)
            else -> {}
        }
        pushHud()
    }

    override fun status(text: String) {
        status = text
        busy = run?.busy ?: false
        hud = hud.copy(step = text.ifEmpty { hud.step }, phase = if (text.isNotEmpty()) "working" else hud.phase)
        pushHud()
    }

    override fun shot(result: ShotResult) {
        val bmp = decodeDataUrl(result.thumb)
        if (bmp != null) {
            val t = ShotThumb(result.n, bmp, result.exposure)
            if (firstShot == null) firstShot = t
            lastShot = t
        }
        hud = hud.copy(thumb = result.thumb, shotsTaken = result.n, shotsMax = run?.shotBudget ?: maxShots)
        pushHud()
    }

    override fun exposure(line: String, diff: List<String>) {
        exposure = line
        hud = hud.copy(exposure = line, diff = if (diff.isNotEmpty()) diff else hud.diff)
        pushHud()
    }

    override suspend fun confirmShot(n: Int, reason: String): Boolean {
        val d = CompletableDeferred<Boolean>()
        approval = ShotApproval(n, reason, d)
        hud = hud.copy(phase = "asking", question = "Take shot $n?", options = listOf("Shoot", "Skip"))
        pushHud()
        return try {
            d.await()
        } finally {
            approval = null
            hud = hud.copy(phase = "working", question = null, options = emptyList())
            pushHud()
        }
    }

    override suspend fun ask(question: String, options: List<String>): String {
        val d = CompletableDeferred<String>()
        this.question = Question(question, options, d)
        hud = hud.copy(phase = "asking", question = question, options = options)
        pushHud()
        return try {
            d.await()
        } finally {
            this.question = null
            hud = hud.copy(phase = "working", question = null, options = emptyList())
            pushHud()
        }
    }

    override fun ended(outcome: Outcome, summary: String?) {
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
            summary = summary ?: hud.summary,
            question = null,
            options = emptyList(),
        )
        pushHud()
    }

    // ---------------------------------------------------------------- voice

    fun toggleRecording() {
        if (recording) stopRecording() else startRecording()
    }

    private fun startRecording() {
        recording = true
        recordJob = viewModelScope.launch {
            try {
                recorder.record()
            } catch (e: Exception) {
                notice = e.message ?: "Couldn't record"
                recording = false
            }
        }
    }

    private fun stopRecording() {
        recording = false
        val wav = recorder.stop() ?: return
        transcribing = true
        viewModelScope.launch {
            try {
                recordJob?.join()
                val text = worker.transcribe(wav)
                if (text.isBlank()) notice = "Didn't catch that. Try again."
                else {
                    goal = text
                    submit()
                }
            } catch (e: Exception) {
                notice = e.message ?: "Transcription failed"
            } finally {
                transcribing = false
            }
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
        viewModelScope.launch {
            try {
                val w = worker
                val s = w.createSession()
                room = GlassesRoom(w, s.code, s.token, viewModelScope, this@AppViewModel).also {
                    it.start()
                    it.sendHud(hud)
                }
                // Ask for a pattern once the socket is up.
                pendingPair = true
            } catch (e: Exception) {
                notice = "Couldn't start a glasses session: ${e.message}"
                showGlasses = false
            }
        }
    }

    private var pendingPair = false

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
        viewModelScope.launch {
            val q = question
            when {
                q != null -> answer(text)
                approval != null -> approve(!Regex("""\b(no|skip|don't|stop)\b""", RegexOption.IGNORE_CASE).containsMatchIn(text))
                else -> {
                    goal = text
                    submit()
                }
            }
        }
    }

    private fun pushHud() {
        room?.sendHud(hud)
    }

    override fun onCleared() {
        run?.cancel()
        room?.stop()
    }
}

fun decodeDataUrl(url: String): Bitmap? = try {
    val bytes = Base64.decode(url.substringAfter(","), Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
} catch (_: Exception) {
    null
}
