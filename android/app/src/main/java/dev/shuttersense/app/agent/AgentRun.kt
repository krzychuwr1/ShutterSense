package dev.shuttersense.app.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

// The agent loop. Runs on the phone, because the phone talks to the camera:
// sends the transcript to /api/agent, executes the tool calls the model makes
// on the camera, appends the results, and repeats until the model calls
// finish. Calls are stateless: the full compact transcript goes up each time,
// with only the latest few images attached. A port of agent/loop.ts.

/** GUIDE: a setting the API can't change, with the path through the camera's menus. */
enum class StepKind { GOAL, THINK, LOOK, SETTINGS, SHOT, TELL, ASK, ANSWER, INSTRUCTION, GUIDE, DONE, ERROR }

data class StepEntry(
    val kind: StepKind,
    val text: String,
    /** Settings diff lines, question options, the shot's exposure, or menu steps. */
    val detail: List<String> = emptyList(),
    val errors: List<String> = emptyList(),
    val image: String? = null,
    /** The setting a GUIDE step is about. */
    val title: String? = null,
    /** A GUIDE step's path as camera menu screens (may be empty: then [detail] has the steps as text). */
    val menu: List<MenuScreen> = emptyList(),
    val id: Long = nextId++,
) {
    companion object {
        private var nextId = 1L
    }
}

enum class Outcome { DONE, CANCELLED, ERROR }

interface RunUi {
    fun step(entry: StepEntry)

    /** The current activity, for the status line and the lens ("Looking…", "Shooting 2/5…"). */
    fun status(text: String)
    fun shot(result: ShotResult)

    /** Settings or exposure changed. */
    fun exposure(line: String, diff: List<String>)

    /** "Ask before shooting" is on: may the agent take shot [n]? */
    suspend fun confirmShot(n: Int, reason: String): Boolean
    suspend fun ask(question: String, options: List<String>): String

    /** The run ended: finished, cancelled or failed. [lens] is the summary cut to one line for the glasses. */
    fun ended(outcome: Outcome, summary: String?, lens: String?)
}

class RunOptions(
    var maxShots: Int,
    var askBeforeShooting: Boolean,
    val glasses: () -> Boolean,
    val session: String,
)

/** Model steps per run, a backstop against loops. */
private const val MAX_ROUNDS = 30

/** Images kept attached in the transcript; older ones are replaced by a note. */
private const val KEEP_IMAGES = 3

/** Extra shots a correction after "done" gets. */
private const val FOLLOW_UP_SHOTS = 3

/** Longest summary the glasses' lens shows. */
private const val LENS_MAX = 90

/** One line for the lens: the model's own short version, or the summary's first sentence, cut at a word. */
fun lensLine(summary: String, short: String = ""): String {
    val s = short.trim().ifEmpty { summary.trim().split(Regex("(?<=[.!?])\\s+")).first() }
    if (s.length <= LENS_MAX) return s
    val cut = s.take(LENS_MAX - 1)
    return cut.take(maxOf(cut.lastIndexOf(' '), LENS_MAX / 2)).trimEnd(',', ';', ':', ' ') + "…"
}

/** What finish returned: the summary for the phone and its one-line version for the lens. */
private class Finished(val summary: String, val lens: String)

const val DEFAULT_MAX_SHOTS = 5

class AgentRun(
    private val api: AgentApi,
    private val camera: CameraTools,
    private val ui: RunUi,
    private val opts: RunOptions,
    private val scope: CoroutineScope,
) {
    private val input = mutableListOf<JsonObject>()
    private val pending = mutableListOf<String>()
    private var shots = 0
    private var maxShots = opts.maxShots.takeIf { it > 0 } ?: DEFAULT_MAX_SHOTS
    private var job: Job? = null
    private var goal = ""
    private var cameraName = "Camera"

    val busy: Boolean get() = job?.isActive == true
    val shotsTaken: Int get() = shots
    val shotBudget: Int get() = maxShots

    /** Starts a new goal. */
    fun start(goal: String) {
        if (busy) return
        this.goal = goal.trim()
        input.clear()
        input.add(userText("Goal: ${this.goal}"))
        shots = 0
        maxShots = opts.maxShots.takeIf { it > 0 } ?: DEFAULT_MAX_SHOTS
        ui.step(StepEntry(StepKind.GOAL, this.goal))
        cameraName = camera.describe()
        launchLoop()
    }

    /** A correction from the photographer: queued while running, or a follow-up run after one ended. */
    fun instruct(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        ui.step(StepEntry(StepKind.INSTRUCTION, t))
        if (busy) {
            pending.add(t)
            return
        }
        if (goal.isEmpty()) return start(t)
        pending.add(t)
        maxShots = shots + FOLLOW_UP_SHOTS
        launchLoop()
    }

    fun cancel() {
        job?.cancel()
    }

    private fun context() = AgentContext(goal, cameraName, shots, maxShots, opts.askBeforeShooting, opts.glasses())

    private fun launchLoop() {
        job = scope.launch { loop() }
    }

    private suspend fun loop() {
        var summary: String? = null
        var lens: String? = null
        var outcome = Outcome.DONE
        try {
            for (round in 0 until MAX_ROUNDS) {
                for (t in pending.toList()) input.add(userText("[Photographer] $t"))
                pending.clear()
                ui.status(if (round == 0) "Thinking…" else "Deciding next step…")
                val res = api.step(opts.session, withRecentImages(input), context())
                // The model often says the same thing in its commentary and in tell_user; show it once.
                val told = res.calls.any { it.name == "tell_user" && it.arguments.contains(res.commentary.take(24)) }
                if (res.commentary.isNotEmpty() && !told) ui.step(StepEntry(StepKind.THINK, res.commentary))
                if (res.calls.isEmpty()) {
                    // Answered in text instead of finishing: treat that as the summary.
                    summary = res.text.ifEmpty { null }
                    summary?.let {
                        lens = lensLine(it)
                        ui.step(StepEntry(StepKind.DONE, it))
                    }
                    break
                }
                for (c in res.calls) {
                    input.add(buildJsonObject {
                        put("type", "function_call")
                        put("call_id", c.callId)
                        put("name", c.name)
                        put("arguments", c.arguments)
                    })
                }
                var finished = false
                for (call in res.calls) {
                    val (output, done) = exec(call)
                    input.add(buildJsonObject {
                        put("type", "function_call_output")
                        put("call_id", call.callId)
                        put("output", output)
                    })
                    if (done != null) {
                        finished = true
                        summary = done.summary
                        lens = done.lens
                    }
                }
                if (finished) break
                if (round == MAX_ROUNDS - 1) ui.step(StepEntry(StepKind.ERROR, "Stopped: the agent took too many steps."))
            }
        } catch (e: CancellationException) {
            outcome = Outcome.CANCELLED
            ui.step(StepEntry(StepKind.ERROR, "Cancelled."))
        } catch (e: Exception) {
            outcome = Outcome.ERROR
            ui.step(StepEntry(StepKind.ERROR, e.message ?: e.toString()))
        } finally {
            ui.status("")
            ui.ended(outcome, summary, lens)
        }
    }

    /** Runs one tool call. The second value is set when the run should end (finish was called). */
    private suspend fun exec(call: FunctionCall): Pair<JsonElement, Finished?> {
        val args: JsonObject = try {
            Json.parseToJsonElement(call.arguments.ifEmpty { "{}" }) as? JsonObject ?: return out("ERROR: arguments were not a JSON object.")
        } catch (_: Exception) {
            return out("ERROR: arguments were not a JSON object.")
        }
        fun text(key: String, max: Int): String =
            ((args[key] as? JsonPrimitive)?.contentOrNull ?: "").replace(Regex("\\s+"), " ").trim().take(max)
        try {
            when (call.name) {
                "get_camera_state" -> {
                    ui.status("Reading the camera…")
                    return out(camera.getState())
                }
                "look" -> {
                    val zoom = (args["zoom"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toInt()?.takeIf { it > 0 }
                    ui.status(if (zoom != null) "Checking focus…" else "Looking…")
                    val (t, image) = camera.look(zoom)
                    ui.step(StepEntry(StepKind.LOOK, if (zoom != null) "Checked focus at ${zoom}×" else "Checked live view", image = image.dataUrl))
                    return imageOutput(t, image) to null
                }
                "detect_flicker" -> {
                    val kind = if ((args["kind"] as? JsonPrimitive)?.contentOrNull == "high_frequency") "high_frequency" else "mains"
                    ui.status("Checking the lights for flicker\u2026")
                    val (applied, t) = camera.detectFlicker(kind)
                    if (applied.isNotEmpty()) {
                        ui.step(StepEntry(StepKind.SETTINGS, text("reason", 160).ifEmpty { "Matched the shutter to the flickering light" }, detail = applied))
                        ui.exposure(camera.exposureLine(), applied)
                    } else ui.step(StepEntry(StepKind.TELL, t.take(140)))
                    return out(t)
                }
                "focus" -> {
                    val x = (args["x"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
                    val y = (args["y"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
                    if (x == null || y == null) return out("ERROR: x and y must be numbers from 0 to 1.")
                    ui.status("Moving the AF point…")
                    val (applied, t) = camera.focusAt(x, y)
                    ui.step(StepEntry(StepKind.SETTINGS, text("reason", 160).ifEmpty { "Moved the AF point" }, detail = applied))
                    ui.exposure(camera.exposureLine(), applied)
                    return out(t)
                }
                "set_settings" -> {
                    val changes = AGENT_SETTINGS.filter { it in args }.associateWith { args[it]!! }.toMutableMap()
                    (args["style_detail"] as? JsonObject)?.let { changes["style_detail"] = it }
                    if (changes.isEmpty()) return out("ERROR: no settings given.")
                    ui.status("Changing settings…")
                    val r = camera.set(changes)
                    val reason = text("reason", 160)
                    ui.step(StepEntry(StepKind.SETTINGS, reason.ifEmpty { "Changed settings" }, detail = r.applied, errors = r.errors))
                    val line = camera.exposureLine()
                    ui.exposure(line, r.applied)
                    val parts = mutableListOf(if (r.applied.isNotEmpty()) "Applied: ${r.applied.joinToString("; ")}." else "Nothing changed.")
                    if (r.errors.isNotEmpty()) parts.add("Rejected: ${r.errors.joinToString(" ")}")
                    parts.add("Exposure now: $line.")
                    return out(parts.joinToString("\n"))
                }
                "shoot" -> {
                    if (shots >= maxShots) return out("ERROR: all $maxShots test shots are used. Call finish with the best result so far.")
                    val n = shots + 1
                    val reason = text("reason", 160)
                    if (opts.askBeforeShooting) {
                        ui.status("Waiting for your OK to take shot $n…")
                        if (!ui.confirmShot(n, reason)) return out("ERROR: the photographer declined this shot.")
                    }
                    ui.status("Shooting $n/$maxShots…")
                    val af = (args["af"] as? JsonPrimitive)?.booleanOrNull != false
                    val result = camera.shoot(af, n)
                    shots = n
                    ui.shot(result)
                    ui.step(StepEntry(StepKind.SHOT, if (reason.isNotEmpty()) "Shot $n: $reason" else "Shot $n", detail = listOf(result.exposure), image = result.image.dataUrl))
                    val left = maxShots - n
                    return imageOutput("Shot $n of $maxShots ($left left). Taken at ${result.exposure}. ${statsLine(result.image.stats)}", result.image) to null
                }
                "tell_user" -> {
                    val t = text("text", 140)
                    if (t.isEmpty()) return out("ERROR: text is empty.")
                    ui.step(StepEntry(StepKind.TELL, t))
                    return out("Shown.")
                }
                "menu_steps" -> {
                    val setting = text("setting", 60)
                    val steps = (args["steps"] as? JsonArray)
                        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.replace(Regex("\\s+"), " ")?.trim()?.take(80) }
                        ?.filter { it.isNotEmpty() }?.take(8) ?: emptyList()
                    if (setting.isEmpty() || steps.isEmpty()) return out("ERROR: give the setting and the steps.")
                    ui.step(StepEntry(StepKind.GUIDE, text("why", 160), detail = steps, title = setting, menu = cleanMenu(args["screens"])))
                    ui.status("Waiting for you to change it on the camera…")
                    val answer = ui.ask("Set $setting on the camera", listOf("Done", "Skip"))
                    ui.step(StepEntry(StepKind.ANSWER, answer))
                    return out(if (answer == "Skip") "The photographer skipped $setting." else "The photographer says $setting is set ($answer).")
                }
                "ask_user" -> {
                    val q = text("question", 160)
                    val options = (args["options"] as? JsonArray)
                        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.replace(Regex("\\s+"), " ")?.trim()?.take(40) }
                        ?.filter { it.isNotEmpty() }?.take(4) ?: emptyList()
                    if (q.isEmpty()) return out("ERROR: question is empty.")
                    ui.step(StepEntry(StepKind.ASK, q, detail = options))
                    ui.status("Waiting for your answer…")
                    val answer = ui.ask(q, options)
                    ui.step(StepEntry(StepKind.ANSWER, answer))
                    return out("The photographer answered: $answer")
                }
                "finish" -> {
                    val summary = text("summary", 900).ifEmpty { "Done." }
                    ui.step(StepEntry(StepKind.DONE, summary))
                    return JsonPrimitive("Finished.") to Finished(summary, lensLine(summary, text("lens", 200)))
                }
                else -> return out("ERROR: unknown tool ${call.name}.")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return out("ERROR: ${e.message ?: e.toString()}")
        }
    }

    private fun out(s: String): Pair<JsonElement, Finished?> = JsonPrimitive(s) to null
}

private fun userText(text: String) = buildJsonObject {
    put("role", "user")
    put("content", buildJsonArray {
        add(buildJsonObject {
            put("type", "input_text")
            put("text", text)
        })
    })
}

private fun imageOutput(text: String, image: PreparedImage): JsonElement = buildJsonArray {
    add(buildJsonObject {
        put("type", "input_text")
        put("text", text)
    })
    add(buildJsonObject {
        put("type", "input_image")
        put("image_url", image.dataUrl)
    })
}

/** A copy of the transcript with only the last KEEP_IMAGES images attached. */
fun withRecentImages(input: List<JsonObject>): List<JsonObject> {
    var keep = KEEP_IMAGES
    val out = input.toMutableList()
    for (i in input.indices.reversed()) {
        val item = input[i]
        val isOutput = (item["type"] as? JsonPrimitive)?.contentOrNull == "function_call_output"
        val parts = (if (isOutput) item["output"] else item["content"]) as? JsonArray ?: continue
        if (parts.none { ((it as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull == "input_image" }) continue
        if (keep > 0) {
            keep--
            continue
        }
        val stripped = JsonArray(parts.map { p ->
            val o = p as? JsonObject
            if ((o?.get("type") as? JsonPrimitive)?.contentOrNull == "input_image") {
                buildJsonObject {
                    put("type", "input_text")
                    put("text", "[older image removed]")
                }
            } else p
        })
        out[i] = JsonObject(item.toMutableMap().apply { put(if (isOutput) "output" else "content", stripped) })
    }
    return out
}
