package dev.shuttersense.app.agent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Collections

// The agent loop. Runs on the phone, because the phone talks to the camera:
// sends the transcript to /api/agent, executes the tool calls the model makes
// on the camera, appends the results, and repeats until the model calls
// finish. Calls are stateless: the full compact transcript goes up each time,
// with only the latest few images attached. A port of agent/loop.ts.

/**
 * GUIDE: a setting the API can't change, with the path through the camera's
 * menus. PRESET: a preset was saved. IDEAS: picture ideas to flip through.
 */
enum class StepKind { GOAL, THINK, LOOK, SETTINGS, SHOT, TELL, ASK, ANSWER, INSTRUCTION, GUIDE, PRESET, IDEAS, DONE, ERROR }

data class StepEntry(
    val kind: StepKind,
    val text: String,
    /** Settings diff lines, question options, the shot's exposure, menu steps, or a preset's settings. */
    val detail: List<String> = emptyList(),
    val errors: List<String> = emptyList(),
    val image: String? = null,
    /** The setting a GUIDE step is about; a PRESET step's preset name. */
    val title: String? = null,
    /** A GUIDE step's path as camera menu screens (may be empty: then [detail] has the steps as text). */
    val menu: List<MenuScreen> = emptyList(),
    /** An IDEAS step's picture ideas. */
    val ideas: List<Idea> = emptyList(),
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

    /** The photographer says they set a menu setting by hand (a simulated camera applies it). */
    suspend fun handSet(setting: String, value: String) {}

    /** The run ended: finished, cancelled or failed. [lens] is the summary cut to one line for the glasses. */
    fun ended(outcome: Outcome, summary: String?, lens: String?)
}

class RunOptions(
    val maxShots: Int,
    val askBeforeShooting: Boolean,
    val glasses: () -> Boolean,
    val session: String,
    /** Where the photographer's presets live; without it save_preset fails and none are listed. */
    val presets: PresetStore? = null,
)

/** Model steps per run, a backstop against loops. */
private const val MAX_ROUNDS = 30

/** Images kept attached in the transcript; older ones are replaced by a note. */
private const val KEEP_IMAGES = 3

/** Most transcript items sent per step (the worker's AGENT_LIMITS.maxItems, less 10); older tool rounds are dropped. */
private const val MAX_ITEMS = 110

/** Extra shots a correction after "done" gets. */
private const val FOLLOW_UP_SHOTS = 3

/** Long side of idea pictures: they go to the lens too, so they stay small. */
private const val IDEA_SIDE = 400

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

    /** Starts a new goal. A run still going (say, cancelled but finishing a camera call) is stopped first. */
    fun start(goal: String) {
        job?.cancel()
        launchLoop { begin(goal) }
    }

    private fun begin(goal: String) {
        this.goal = goal.trim()
        input.clear()
        input.add(userText("Goal: ${this.goal}"))
        pending.clear()
        shots = 0
        maxShots = opts.maxShots.takeIf { it > 0 } ?: DEFAULT_MAX_SHOTS
        ui.step(StepEntry(StepKind.GOAL, this.goal))
        cameraName = camera.describe()
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

    private fun context() = AgentContext(
        goal, cameraName, shots, maxShots, opts.askBeforeShooting, opts.glasses(),
        (opts.presets?.list() ?: emptyList()).map(::presetSummary),
    )

    /**
     * Runs [before] and the loop once the previous run has ended: a cancelled
     * run is no longer busy but may still be finishing a camera call, and two
     * loops mustn't share the transcript.
     */
    private fun launchLoop(before: () -> Unit = {}) {
        // Not isActive: a cancelled job is no longer active while it finishes.
        val previous = job?.takeIf { !it.isCompleted }
        if (previous == null) {
            before()
            job = scope.launch { loop() }
            return
        }
        job = scope.launch {
            // Waits out the old run even if this one is replaced meanwhile, so the next one waits for it too.
            withContext(NonCancellable) { previous.join() }
            ensureActive()
            before()
            loop()
        }
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
                val res = api.step(opts.session, withRecentImages(withoutOldRounds(input)), context())
                // The model often says the same thing in its commentary and in tell_user; show it once.
                val told = res.calls.any { it.name == "tell_user" && it.arguments.contains(res.commentary.take(24)) }
                if (res.commentary.isNotEmpty() && !told) ui.step(StepEntry(StepKind.THINK, res.commentary))
                if (res.calls.isEmpty()) {
                    // Answered in text instead of finishing: treat that as the summary.
                    if (res.text.isNotEmpty()) {
                        input.add(buildJsonObject {
                            put("role", "assistant")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "output_text")
                                    put("text", res.text)
                                })
                            })
                        })
                        summary = res.text
                        lens = lensLine(res.text)
                        ui.step(StepEntry(StepKind.DONE, res.text))
                    }
                    // A correction that arrived while the model was answering still gets its turn.
                    if (pending.isNotEmpty()) continue
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
                // As above: a correction sent while the model was finishing reopens the run.
                if (finished && pending.isEmpty()) break
                if (round == MAX_ROUNDS - 1) ui.step(StepEntry(StepKind.ERROR, "Stopped: the agent took too many steps."))
            }
        } catch (e: CancellationException) {
            outcome = Outcome.CANCELLED
            ui.step(StepEntry(StepKind.ERROR, "Cancelled."))
        } catch (e: Exception) {
            outcome = Outcome.ERROR
            ui.step(StepEntry(StepKind.ERROR, e.message ?: e.toString()))
        } finally {
            // Calls cut short still need an output, or a follow-up run's transcript is invalid.
            answerOpenCalls(if (outcome == Outcome.CANCELLED) "ERROR: cancelled by the photographer." else "ERROR: the run stopped before this call finished.")
            ui.status("")
            ui.ended(outcome, summary, lens)
        }
    }

    private fun answerOpenCalls(output: String) {
        fun callId(i: JsonObject) = (i["call_id"] as? JsonPrimitive)?.contentOrNull
        fun type(i: JsonObject) = (i["type"] as? JsonPrimitive)?.contentOrNull
        val answered = input.filter { type(it) == "function_call_output" }.mapTo(HashSet()) { callId(it) }
        val open = input.filter { type(it) == "function_call" && callId(it) !in answered }
        for (c in open) {
            input.add(buildJsonObject {
                put("type", "function_call_output")
                put("call_id", callId(c))
                put("output", output)
            })
        }
    }

    /** Runs one tool call. The second value is set when the run should end (finish was called). */
    private suspend fun exec(call: FunctionCall): Pair<JsonElement, Finished?> {
        val args: JsonObject = try {
            Json.parseToJsonElement(call.arguments.ifEmpty { "{}" }) as? JsonObject ?: return out("ERROR: arguments were not a JSON object.")
        } catch (_: Exception) {
            return out("ERROR: arguments were not a JSON object.")
        }
        fun text(key: String, max: Int): String = clip(args[key], max)
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
                    // Only a JSON false turns AF off (booleanOrNull also reads the string "false").
                    val af = (args["af"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != false
                    // Counted before the press: a shot whose download fails was still taken.
                    shots = n
                    val result = camera.shoot(af, n)
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
                    val steps = (args["steps"] as? JsonArray)?.map { clip(it, 80) }?.filter { it.isNotEmpty() }?.take(8) ?: emptyList()
                    if (setting.isEmpty() || steps.isEmpty()) return out("ERROR: give the setting and the steps.")
                    ui.step(StepEntry(StepKind.GUIDE, text("why", 160), detail = steps, title = setting, menu = cleanMenu(args["screens"])))
                    ui.status("Waiting for you to change it on the camera…")
                    val answer = ui.ask("Set $setting on the camera", listOf("Done", "Skip"))
                    ui.step(StepEntry(StepKind.ANSWER, answer))
                    if (answer != "Skip") ui.handSet(setting, text("value", 40))
                    return out(if (answer == "Skip") "The photographer skipped $setting." else "The photographer says $setting is set ($answer).")
                }
                "save_preset" -> {
                    val store = opts.presets ?: return out("ERROR: this app can't store presets.")
                    val name = text("name", PRESET_NAME)
                    if (name.isEmpty()) return out("ERROR: give the preset a name.")
                    val existing = store.list()
                    if (existing.size >= PRESET_COUNT && existing.none { presetKey(it.name) == presetKey(name) }) {
                        return out("ERROR: the phone already holds $PRESET_COUNT presets; the photographer has to delete one first.")
                    }
                    ui.status("Saving the preset…")
                    val keys = (args["keys"] as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: it.toString() }
                    val settings = camera.snapshot(keys)
                    val preset = cleanPreset(buildJsonObject {
                        put("name", name)
                        args["note"]?.let { put("note", it) }
                        put("settings", settings)
                        args["menu"]?.let { put("menu", it) }
                        put("saved", ISO_DATE.format(Instant.now()))
                    }) ?: return out("ERROR: the preset couldn't be saved.")
                    store.save(preset)
                    ui.step(StepEntry(StepKind.PRESET, preset.note.ifEmpty { "Saved as a preset" }, detail = presetLines(preset), title = preset.name))
                    return out("Saved preset \"${preset.name}\": ${presetLine(preset)}.")
                }
                "apply_preset" -> {
                    val want = presetKey(text("name", PRESET_NAME))
                    val presets = opts.presets?.list() ?: emptyList()
                    val preset = presets.find { presetKey(it.name) == want }
                        ?: return out("ERROR: no preset called \"${text("name", 40)}\". Saved presets: ${presets.joinToString(", ") { it.name }.ifEmpty { "none" }}.")
                    ui.status("Applying ${preset.name}…")
                    val r = camera.set(preset.settings)
                    ui.step(StepEntry(StepKind.SETTINGS, "Applied preset \"${preset.name}\"", detail = r.applied, errors = r.errors))
                    val line = camera.exposureLine()
                    ui.exposure(line, r.applied)
                    val parts = mutableListOf(if (r.applied.isNotEmpty()) "Applied: ${r.applied.joinToString("; ")}." else "The camera already matched the preset.")
                    if (r.errors.isNotEmpty()) parts.add("Rejected: ${r.errors.joinToString(" ")}")
                    // The matched speed depends on the lights where the photographer is now, so it isn't stored.
                    if ((preset.settings["hfantiflickershoot"] as? JsonPrimitive)?.contentOrNull == "enable") {
                        parts.add("HF anti-flicker is on in this preset: call detect_flicker with kind high_frequency to match these lights.")
                    }
                    if (preset.menu.isNotEmpty()) {
                        parts.add("Set by hand in the menus (call menu_steps for each one that isn't set yet): ${preset.menu.joinToString("; ") { "${it.setting} = ${it.value}" }}.")
                    }
                    parts.add("Exposure now: $line.")
                    return out(parts.joinToString("\n"))
                }
                "show_ideas" -> {
                    val ideas = ((args["ideas"] as? JsonArray) ?: emptyList<JsonElement>())
                        .take(INSPIRE_IDEAS)
                        .map { it as? JsonObject ?: JsonObject(emptyMap()) }
                        .map { IdeaPlan(clip(it["title"], INSPIRE_TITLE), clip(it["direction"], INSPIRE_DIRECTION), clip(it["prompt"], INSPIRE_PROMPT)) }
                        .filter { it.title.isNotEmpty() && it.prompt.isNotEmpty() }
                    if (ideas.isEmpty()) return out("ERROR: give at least one idea with a title and a prompt.")
                    var frame: String? = null
                    if ((args["from_camera"] as? JsonPrimitive)?.let { !it.isString && it.booleanOrNull == true } == true) {
                        ui.status("Looking…")
                        frame = camera.look().second.dataUrl
                    }
                    ui.status(if (ideas.size == 1) "Picturing the idea…" else "Picturing ${ideas.size} ideas…")
                    val failures: MutableList<String> = Collections.synchronizedList(mutableListOf())
                    // All at once: each picture takes a while. Cancelling the run cancels them all.
                    val pictures = coroutineScope {
                        ideas.map { idea ->
                            async {
                                if (!api.canInspire) return@async null
                                try {
                                    camera.ideaPicture(api.inspire(opts.session, idea.prompt, frame), IDEA_SIDE)
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    failures.add(e.message ?: e.toString())
                                    null
                                }
                            }
                        }.awaitAll()
                    }
                    val shown = ideas.mapIndexed { k, i -> Idea(i.title, i.direction, pictures[k]) }
                    ui.step(StepEntry(StepKind.IDEAS, if (frame != null) "Ideas for this scene" else "Ideas", ideas = shown))
                    val made = pictures.count { it != null }
                    val note = when {
                        !api.canInspire -> "This app shows them as text only."
                        made < ideas.size -> "$made of ${ideas.size} pictures were made (${failures.firstOrNull() ?: "unknown error"}); the rest show as text."
                        else -> ""
                    }
                    return out("Showed ${ideas.size} ideas on the phone and the lens: ${ideas.joinToString("; ") { it.title }}. $note".trim())
                }
                "ask_user" -> {
                    val q = text("question", 160)
                    val options = (args["options"] as? JsonArray)?.map { clip(it, 40) }?.filter { it.isNotEmpty() }?.take(4) ?: emptyList()
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

/** An idea as show_ideas gave it, before its picture is made. */
private class IdeaPlan(val title: String, val direction: String, val prompt: String)

private val SPACES = Regex("\\s+")

/** A tool argument as text: squeezed to single spaces, trimmed and cut to [max] ("" when missing). */
private fun clip(e: JsonElement?, max: Int): String =
    ((e as? JsonPrimitive)?.contentOrNull ?: "").replace(SPACES, " ").trim().take(max)

/** An ISO date as JavaScript's toISOString writes it. */
private val ISO_DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

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

/**
 * The transcript within [max] items: the oldest tool rounds give way to a
 * note, while the goal and the photographer's messages stay. Cuts fall
 * between rounds, so a call and its output always go together.
 */
fun withoutOldRounds(input: List<JsonObject>, max: Int = MAX_ITEMS): List<JsonObject> {
    if (input.size <= max) return input
    fun str(i: JsonObject, key: String) = (i[key] as? JsonPrimitive)?.contentOrNull
    for (k in 2 until input.size) {
        if (str(input[k], "type") == "function_call_output" || str(input[k - 1], "type") == "function_call") continue
        val messages = input.subList(1, k).filter { str(it, "role") == "user" }
        if (messages.size + input.size - k + 2 > max) continue
        return listOf(input[0]) + messages + userText(PRUNED_NOTE) + input.subList(k, input.size)
    }
    // Even the photographer's messages don't fit: keep the latest of them and the last round.
    for (k in input.size - 1 downTo 2) {
        if (str(input[k], "type") == "function_call_output" || str(input[k - 1], "type") == "function_call") continue
        val room = max - (input.size - k) - 2
        if (room < 0) break
        val messages = input.subList(1, k).filter { str(it, "role") == "user" }
        return listOf(input[0]) + messages.takeLast(room) + userText(PRUNED_NOTE) + input.subList(k, input.size)
    }
    return input
}

private const val PRUNED_NOTE = "[Earlier steps removed to keep the request small.]"

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
