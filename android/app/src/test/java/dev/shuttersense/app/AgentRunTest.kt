package dev.shuttersense.app

import dev.shuttersense.app.agent.AgentApi
import dev.shuttersense.app.agent.AgentContext
import dev.shuttersense.app.agent.AgentResponse
import dev.shuttersense.app.agent.AgentRun
import dev.shuttersense.app.agent.CameraTools
import dev.shuttersense.app.agent.FunctionCall
import dev.shuttersense.app.agent.Idea
import dev.shuttersense.app.agent.ImageStats
import dev.shuttersense.app.agent.ImageTools
import dev.shuttersense.app.agent.Outcome
import dev.shuttersense.app.agent.PRESET_COUNT
import dev.shuttersense.app.agent.PreparedImage
import dev.shuttersense.app.agent.Preset
import dev.shuttersense.app.agent.PresetStore
import dev.shuttersense.app.agent.StepKind
import dev.shuttersense.app.agent.WorkerException
import dev.shuttersense.app.agent.cleanPreset
import dev.shuttersense.app.agent.presetKey
import dev.shuttersense.app.agent.repeatsNote
import dev.shuttersense.app.agent.RunOptions
import dev.shuttersense.app.agent.RunUi
import dev.shuttersense.app.agent.ShotResult
import dev.shuttersense.app.agent.StepEntry
import dev.shuttersense.app.agent.withoutOldRounds
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.ccapi.CcapiTransport
import dev.shuttersense.app.ccapi.RawResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AgentRunTest {
    private var ids = 0
    private fun call(name: String, args: String = "{}") = FunctionCall("$name-${ids++}", name, args)
    private fun reply(vararg calls: FunctionCall) = AgentResponse(calls.toList(), "", "")

    private val SHADE = "Her face is in deep tree shade against a sunlit meadow — too wide a brightness range for one exposure, and flash is off the table. I'll use HDR to hold both."
    private val SHADE_AGAIN = "Her face is in deep tree shade against a sunlit meadow — lifting exposure would blow out the grass, and flash is off as requested. I'll have you enable HDR so the camera merges exposures and holds both her face and the meadow."

    /** A camera the tested tools never reach. */
    private val camera = CameraTools(
        CcapiClient { _, _, _, _ -> throw IllegalStateException("no camera in this test") },
        object : ImageTools {
            override suspend fun prepare(jpeg: ByteArray, maxSide: Int, quality: Double): PreparedImage = error("no images in this test")
        },
    )

    private open class FakeUi : RunUi {
        val ended = mutableListOf<Outcome>()
        val summaries = mutableListOf<String?>()
        val steps = mutableListOf<StepEntry>()
        override fun step(entry: StepEntry) {
            steps.add(entry)
        }
        override fun status(text: String) {}
        override fun shot(result: ShotResult) {}
        override fun exposure(line: String, diff: List<String>) {}
        override suspend fun confirmShot(n: Int, reason: String) = true
        override suspend fun ask(question: String, options: List<String>) = "Done"
        override fun ended(outcome: Outcome, summary: String?, lens: String?) {
            ended.add(outcome)
            summaries.add(summary)
        }
    }

    private open class RecordingApi(val answer: (Int) -> AgentResponse) : AgentApi {
        val requests = mutableListOf<List<JsonObject>>()
        val contexts = mutableListOf<AgentContext>()
        override suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse {
            requests.add(input.toList())
            contexts.add(context)
            return answer(requests.size)
        }
    }

    /** An API that also makes idea pictures, with [picture] standing in for /api/inspire. */
    private class InspiringApi(answer: (Int) -> AgentResponse, val picture: suspend (String, String?) -> String) : RecordingApi(answer) {
        override val canInspire get() = true
        override suspend fun inspire(session: String, prompt: String, image: String?) = picture(prompt, image)
    }

    private class MemoryPresets : PresetStore {
        val presets = mutableListOf<Preset>()
        override fun list() = presets.toList()
        override fun save(preset: Preset) {
            presets.removeAll { presetKey(it.name) == presetKey(preset.name) }
            presets.add(preset)
        }
    }

    /** The output the transcript holds for the last call named [name]. */
    private fun outputOf(input: List<JsonObject>, name: String): String {
        val id = input.last { str(it, "type") == "function_call" && str(it, "name") == name }.let { str(it, "call_id") }
        return (input.single { str(it, "type") == "function_call_output" && str(it, "call_id") == id }["output"] as JsonPrimitive).content
    }

    private fun outputs(input: List<JsonObject>): List<String> =
        input.filter { str(it, "type") == "function_call_output" }.map { (it["output"] as JsonPrimitive).content }

    /** A camera with a few settings: tv and iso changeable, av chosen by the camera. */
    private class FakeCamera {
        val values = linkedMapOf("tv" to "1/250", "iso" to "auto", "av" to "f2.8")
        private val options = mapOf("tv" to listOf("1/60", "1/250"), "iso" to listOf("auto", "400"), "av" to emptyList())
        private fun ok(json: String) = RawResponse(200, "application/json", json.toByteArray())
        private fun item(k: String) = buildJsonObject {
            put("value", values[k])
            put("ability", JsonArray(options.getValue(k).map { JsonPrimitive(it) }))
        }
        private val endpoints = buildJsonObject {
            put("ver100", JsonArray((listOf("") + values.keys.map { "/$it" }).map { k ->
                buildJsonObject {
                    put("path", "/ccapi/ver100/shooting/settings$k")
                    put("get", true)
                    put("post", false)
                    put("put", k.isNotEmpty())
                    put("delete", false)
                }
            }))
        }
        val tools = CameraTools(
            CcapiClient { method, path, body, _ ->
                val key = path.removePrefix("/ccapi/ver100/shooting/settings").removePrefix("/")
                when {
                    path == "/ccapi" -> ok(endpoints.toString())
                    method == "GET" && path == "/ccapi/ver100/shooting/settings" -> ok(JsonObject(values.keys.associateWith { item(it) }).toString())
                    method == "GET" && key in values -> ok(item(key).toString())
                    method == "PUT" && key in values -> {
                        values[key] = ((body as JsonObject)["value"] as JsonPrimitive).content
                        ok("{}")
                    }
                    else -> RawResponse(404, "application/json", ByteArray(0))
                }
            },
            object : ImageTools {
                override suspend fun prepare(jpeg: ByteArray, maxSide: Int, quality: Double) =
                    PreparedImage("data:image/jpeg;base64,small-$maxSide", maxSide, maxSide, ImageStats(0, 0, 0.0, 0.0))
            },
        )
    }

    private fun str(o: JsonObject, key: String) = (o[key] as? JsonPrimitive)?.contentOrNull

    private fun unanswered(input: List<JsonObject>): Int {
        val answered = input.filter { str(it, "type") == "function_call_output" }.map { str(it, "call_id") }.toSet()
        return input.count { str(it, "type") == "function_call" && str(it, "call_id") !in answered }
    }

    @Test
    fun aRewordedNoteIsARepeatAndANewThoughtIsNot() {
        assertTrue(repeatsNote(SHADE_AGAIN, SHADE))
        assertFalse(
            repeatsNote(
                "Silent electronic shutter + fast LED panels = banding. I'll run HF flicker detection to match the shutter to the LEDs.",
                "Silently but band-free — checking the shutter and light first.",
            ),
        )
        assertFalse(repeatsNote(SHADE, ""))
        assertFalse(repeatsNote("ok", SHADE))
    }

    @Test
    fun commentaryShowsOnceNotNextToTellUserOrRewordedARoundLater() = runTest {
        val replies = ArrayDeque(
            listOf(
                AgentResponse(listOf(call("tell_user", """{"text":"Short note"}""")), "", SHADE),
                AgentResponse(listOf(call("no_such_tool")), "", SHADE_AGAIN),
                AgentResponse(listOf(call("no_such_tool")), "", "The shot came out soft, so servo focus goes on next."),
                reply(call("finish", """{"summary":"ok"}""")),
            ),
        )
        val ui = FakeUi()
        val run = AgentRun(RecordingApi { replies.removeFirst() }, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Keep her face and the meadow")
        advanceUntilIdle()
        val notes = ui.steps.filter { it.kind == StepKind.THINK || it.kind == StepKind.TELL }.map { it.text }
        assertEquals(listOf("Short note", "The shot came out soft, so servo focus goes on next."), notes)
    }

    @Test
    fun cancelledShotApprovalLeavesAValidTranscriptForTheFollowUp() = runTest {
        val replies = ArrayDeque(listOf(reply(call("shoot"), call("tell_user", """{"text":"hi"}""")), reply(call("finish", """{"summary":"ok"}"""))))
        val api = RecordingApi { replies.removeFirst() }
        lateinit var run: AgentRun
        val ui = object : FakeUi() {
            // The prompt never answers; only cancelling ends it.
            override suspend fun confirmShot(n: Int, reason: String): Boolean {
                launch { run.cancel() }
                return CompletableDeferred<Boolean>().await()
            }
        }
        run = AgentRun(api, camera, ui, RunOptions(3, true, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        assertEquals(listOf(Outcome.CANCELLED), ui.ended)
        assertFalse(run.busy)
        run.instruct("try again")
        advanceUntilIdle()
        assertEquals(listOf(Outcome.CANCELLED, Outcome.DONE), ui.ended)
        assertEquals(0, unanswered(api.requests[1]))
        assertTrue(api.requests[1].toString().contains("ERROR: cancelled by the photographer."))
    }

    @Test
    fun correctionSentWhileTheModelFinishesGetsItsTurn() = runTest {
        lateinit var run: AgentRun
        val api = RecordingApi { n ->
            if (n == 1) run.instruct("a bit warmer")
            reply(call("finish", """{"summary":"${if (n == 1) "first" else "second"}"}"""))
        }
        val ui = FakeUi()
        run = AgentRun(api, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        assertEquals(2, api.requests.size)
        assertTrue(api.requests[1].toString().contains("[Photographer] a bit warmer"))
        assertEquals(listOf<String?>("second"), ui.summaries)
    }

    @Test
    fun textAnswerGoesIntoTheTranscript() = runTest {
        val api = RecordingApi { n -> if (n == 1) AgentResponse(emptyList(), "All set.", "") else reply(call("finish")) }
        val ui = FakeUi()
        val run = AgentRun(api, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        assertEquals(listOf<String?>("All set."), ui.summaries)
        run.instruct("warmer")
        advanceUntilIdle()
        val assistant = api.requests[1].single { str(it, "role") == "assistant" }
        assertTrue(assistant.toString().contains("\"output_text\""))
    }

    private fun user(text: String) = buildJsonObject {
        put("role", "user")
        put("content", buildJsonArray { add(buildJsonObject { put("type", "input_text"); put("text", text) }) })
    }

    private fun item(type: String, id: String) = buildJsonObject {
        put("type", type)
        put("call_id", id)
    }

    @Test
    fun longTranscriptsDropWholeOldRounds() {
        val input = mutableListOf(user("Goal: x"))
        for (r in 0 until 40) {
            if (r == 2) input.add(user("[Photographer] warmer"))
            // Two parallel calls per round, then their outputs.
            input += listOf(item("function_call", "a$r"), item("function_call", "b$r"), item("function_call_output", "a$r"), item("function_call_output", "b$r"))
        }
        assertSame(input, withoutOldRounds(input, 200))
        val out = withoutOldRounds(input, 50)
        assertTrue(out.size.toString(), out.size <= 50)
        assertSame(input[0], out[0])
        assertTrue("the photographer's message stays", input[9] in out)
        assertEquals(input.last(), out.last())
        assertTrue(out.any { it.toString().contains("[Earlier steps removed") })
        val calls = out.filter { str(it, "type") == "function_call" }.map { str(it, "call_id") }.sortedBy { it }
        val outputs = out.filter { str(it, "type") == "function_call_output" }.map { str(it, "call_id") }.sortedBy { it }
        assertEquals("every kept call keeps its output", calls, outputs)
    }

    @Test
    fun busyReleaseIsRetriedAloneWithoutAnotherPress() = runBlocking {
        val actions = mutableListOf<String>()
        var busyOnce = true
        val transport = CcapiTransport { method, path, body, _ ->
            when {
                path == "/ccapi" -> RawResponse(
                    200, "application/json",
                    """{"ver100":[{"path":"/ccapi/ver100/shooting/control/shutterbutton/manual","get":false,"post":true,"put":false,"delete":false}]}""".toByteArray(),
                )
                method == "POST" && path.endsWith("/manual") -> {
                    val action = ((body as JsonObject)["action"] as JsonElement).let { (it as JsonPrimitive).content }
                    actions.add(action)
                    if (action == "release" && busyOnce) {
                        busyOnce = false
                        RawResponse(503, "application/json", """{"message":"Device busy"}""".toByteArray())
                    } else RawResponse(200, "application/json", ByteArray(0))
                }
                else -> RawResponse(404, "application/json", ByteArray(0))
            }
        }
        val c = CcapiClient(transport)
        c.discover()
        c.shutter(af = true)
        assertEquals(listOf("full_press", "release", "release"), actions)
    }

    @Test
    fun releaseIsSentEvenWhenCancelledDuringItsRetry() = runBlocking {
        val actions = mutableListOf<String>()
        lateinit var job: Job
        val transport = CcapiTransport { method, path, body, _ ->
            when {
                path == "/ccapi" -> RawResponse(
                    200, "application/json",
                    """{"ver100":[{"path":"/ccapi/ver100/shooting/control/shutterbutton/manual","get":false,"post":true,"put":false,"delete":false}]}""".toByteArray(),
                )
                method == "POST" && path.endsWith("/manual") -> {
                    val action = ((body as JsonObject)["action"] as JsonPrimitive).content
                    actions.add(action)
                    if (action == "release" && actions.size == 2) {
                        // Cancelled while the first release is refused as busy.
                        job.cancel()
                        RawResponse(503, "application/json", """{"message":"Device busy"}""".toByteArray())
                    } else RawResponse(200, "application/json", ByteArray(0))
                }
                else -> RawResponse(404, "application/json", ByteArray(0))
            }
        }
        val c = CcapiClient(transport)
        c.discover()
        job = launch { c.shutter(af = false) }
        job.join()
        assertEquals(listOf("full_press", "release", "release"), actions)
    }

    @Test
    fun aShotWhoseCameraCallFailsIsStillCharged() = runTest {
        val replies = ArrayDeque(listOf(reply(call("shoot")), reply(call("finish", """{"summary":"ok"}"""))))
        val ui = FakeUi()
        // The test camera fails every call, as a failed download would.
        val run = AgentRun(RecordingApi { replies.removeFirst() }, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        assertEquals(1, run.shotsTaken)
    }

    @Test
    fun aNewGoalWaitsForTheCancelledRunToEnd() = runTest {
        val gate = CompletableDeferred<Unit>()
        var first = true
        lateinit var run: AgentRun
        val api = RecordingApi { n -> reply(call("finish", """{"summary":"run $n"}""")) }
        val slow = object : AgentApi {
            override suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse {
                if (first) {
                    first = false
                    // A call that finishes on its own time even when cancelled, then notices.
                    withContext(NonCancellable) { gate.await() }
                    currentCoroutineContext().ensureActive()
                }
                return api.step(session, input, context)
            }
        }
        val ui = FakeUi()
        run = AgentRun(slow, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        run.cancel()
        run.start("Make it moody")
        advanceUntilIdle()
        val waiting = run.busy && ui.ended.isEmpty()
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue("the new goal waits for the old run", waiting)
        assertEquals(listOf(Outcome.CANCELLED, Outcome.DONE), ui.ended)
        assertTrue(api.requests.last().first().toString().contains("Goal: Make it moody"))
    }

    @Test
    fun aCorrectionAfterCancellingWaitsForTheRunToEnd() = runTest {
        val gate = CompletableDeferred<Unit>()
        var first = true
        val api = RecordingApi { n -> reply(call("finish", """{"summary":"run $n"}""")) }
        val slow = object : AgentApi {
            override suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse {
                if (first) {
                    first = false
                    // A call that finishes on its own time even when cancelled, then notices.
                    withContext(NonCancellable) { gate.await() }
                    currentCoroutineContext().ensureActive()
                }
                return api.step(session, input, context)
            }
        }
        val ui = FakeUi()
        val run = AgentRun(slow, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Freeze the dog")
        advanceUntilIdle()
        run.cancel()
        // Not busy any more, but the cancelled run hasn't ended yet.
        run.instruct("a bit warmer")
        advanceUntilIdle()
        val waiting = ui.ended.isEmpty() && api.requests.isEmpty()
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue("the follow-up waits for the cancelled run", waiting)
        assertEquals(listOf(Outcome.CANCELLED, Outcome.DONE), ui.ended)
        assertTrue(api.requests.single().toString().contains("[Photographer] a bit warmer"))
    }

    @Test
    fun tooManyPhotographerMessagesKeepTheLatest() {
        val input = mutableListOf(user("Goal: x"))
        for (r in 0 until 121) input += listOf(user("[Photographer] m$r"), item("function_call", "a$r"), item("function_call_output", "a$r"))
        val out = withoutOldRounds(input, 110)
        assertTrue(out.size.toString(), out.size <= 110)
        assertSame(input[0], out[0])
        assertEquals(input.last(), out.last())
        assertTrue("the latest message stays", input[input.size - 3] in out)
        assertFalse("the oldest goes", input[1] in out)
    }

    @Test
    fun savesTheCameraSettingsAsAPresetAndAppliesItLater() = runTest {
        val cam = FakeCamera()
        cam.tools.client.discover()
        val store = MemoryPresets()
        val replies = ArrayDeque(
            listOf(
                reply(call("save_preset", """{"name":"Club  night","note":"Dim LED stage","menu":[{"setting":"HDR Mode","value":"Auto"}]}""")),
                reply(call("finish", """{"summary":"saved"}""")),
                reply(call("apply_preset", """{"name":"Beach"}"""), call("apply_preset", """{"name":" club NIGHT "}""")),
                reply(call("finish", """{"summary":"applied"}""")),
            ),
        )
        val api = RecordingApi { replies.removeFirst() }
        val ui = FakeUi()
        val run = AgentRun(api, cam.tools, ui, RunOptions(3, false, { false }, "t", store), this)
        run.start("Save this as club night")
        advanceUntilIdle()

        val p = store.presets.single()
        assertEquals("Club night", p.name)
        // av is the camera's choice in this mode, so it isn't kept.
        assertEquals(listOf("tv", "iso"), p.settings.keys.toList())
        assertEquals("Saved preset \"Club night\": tv 1/250, iso auto; by hand: HDR Mode Auto.", outputOf(api.requests[1], "save_preset"))
        val step = ui.steps.single { it.kind == StepKind.PRESET }
        assertEquals("Club night", step.title)
        assertEquals("Dim LED stage", step.text)
        assertEquals(listOf("Shutter: 1/250 s", "ISO: auto", "HDR Mode (by hand): Auto"), step.detail)

        cam.values["tv"] = "1/60"
        run.start("Use my club night preset")
        advanceUntilIdle()
        assertEquals("tv 1/250, iso auto; by hand: HDR Mode Auto", api.contexts.last().presets.single().settings)
        assertEquals("1/250", cam.values["tv"])
        val out = outputs(api.requests.last())
        assertEquals("ERROR: no preset called \"Beach\". Saved presets: Club night.", out[0])
        assertEquals(
            "Applied: Shutter 1/60 s → 1/250 s.\n" +
                "Set by hand in the menus (call menu_steps for each one that isn't set yet): HDR Mode = Auto.\n" +
                "Exposure now: f/2.8 · 1/250 s · ISO auto.",
            out[1],
        )
        assertEquals(listOf(Outcome.DONE, Outcome.DONE), ui.ended)
    }

    @Test
    fun applyingAnHfAntiFlickerPresetAsksForDetection() = runTest {
        val cam = FakeCamera()
        cam.tools.client.discover()
        val store = MemoryPresets()
        store.save(cleanPreset(Json.parseToJsonElement("""{"name":"LED stage","settings":{"tv":"1/250","hfantiflickershoot":"enable"}}"""))!!)
        val replies = ArrayDeque(listOf(reply(call("apply_preset", """{"name":"LED stage"}""")), reply(call("finish"))))
        val api = RecordingApi { replies.removeFirst() }
        val run = AgentRun(api, cam.tools, FakeUi(), RunOptions(3, false, { false }, "t", store), this)
        run.start("LED stage")
        advanceUntilIdle()
        val out = outputOf(api.requests[1], "apply_preset")
        assertTrue(out, out.contains("\nHF anti-flicker is on in this preset: call detect_flicker with kind high_frequency to match these lights.\n"))
        assertTrue(out, out.contains("Rejected: "))
    }

    @Test
    fun presetsAreCappedButAnExistingNameCanBeReplaced() = runTest {
        val cam = FakeCamera()
        cam.tools.client.discover()
        val store = MemoryPresets()
        repeat(PRESET_COUNT) { n -> store.save(cleanPreset(buildJsonObject { put("name", "p$n") })!!) }
        val replies = ArrayDeque(listOf(reply(call("save_preset", """{"name":"new","note":""}"""), call("save_preset", """{"name":"P3","note":"again"}""")), reply(call("finish"))))
        val api = RecordingApi { replies.removeFirst() }
        val run = AgentRun(api, cam.tools, FakeUi(), RunOptions(3, false, { false }, "t", store), this)
        run.start("save it")
        advanceUntilIdle()
        val out = outputs(api.requests[1])
        assertEquals("ERROR: the phone already holds 20 presets; the photographer has to delete one first.", out[0])
        assertTrue(out[1], out[1].startsWith("Saved preset \"P3\""))
        assertEquals(PRESET_COUNT, store.presets.size)
        assertEquals("again", store.presets.last().note)
    }

    @Test
    fun withoutAStoreSavingAPresetFails() = runTest {
        val replies = ArrayDeque(listOf(reply(call("save_preset", """{"name":"x","note":""}""")), reply(call("finish"))))
        val api = RecordingApi { replies.removeFirst() }
        val run = AgentRun(api, camera, FakeUi(), RunOptions(3, false, { false }, "t"), this)
        run.start("save it")
        advanceUntilIdle()
        assertEquals("ERROR: this app can't store presets.", outputOf(api.requests[1], "save_preset"))
        assertTrue(api.contexts.first().presets.isEmpty())
    }

    private val ideasCall = """{"from_camera":false,"ideas":[
        {"title":"Lean in","direction":"Lean on the tree","prompt":"a"},
        {"title":"Walk","prompt":"b"},
        {"title":"No prompt","direction":"x"}]}"""

    @Test
    fun ideaPicturesAreMadeTogetherAndAFailedOneShowsAsText() = runTest {
        val cam = FakeCamera()
        val replies = ArrayDeque(listOf(reply(call("show_ideas", ideasCall)), reply(call("finish"))))
        val gate = CompletableDeferred<Unit>()
        var started = 0
        val api = InspiringApi({ replies.removeFirst() }) { prompt, image ->
            assertNull(image)
            // Both pictures are asked for before either answers.
            if (++started == 2) gate.complete(Unit)
            gate.await()
            if (prompt == "b") throw WorkerException("The demo is very busy")
            "data:image/webp;base64,AAAA"
        }
        val ui = FakeUi()
        val run = AgentRun(api, cam.tools, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Ideas for the couple")
        advanceUntilIdle()
        assertEquals(listOf(Outcome.DONE), ui.ended)
        val step = ui.steps.single { it.kind == StepKind.IDEAS }
        assertEquals("Ideas", step.text)
        assertEquals(listOf(Idea("Lean in", "Lean on the tree", "data:image/jpeg;base64,small-400"), Idea("Walk", "", null)), step.ideas)
        assertEquals(
            "Showed 2 ideas on the phone and the lens: Lean in; Walk. 1 of 2 pictures were made (The demo is very busy); the rest show as text.",
            outputOf(api.requests[1], "show_ideas"),
        )
    }

    @Test
    fun withoutPicturesIdeasShowAsText() = runTest {
        val replies = ArrayDeque(listOf(reply(call("show_ideas", ideasCall)), reply(call("show_ideas", """{"ideas":[]}""")), reply(call("finish"))))
        val api = RecordingApi { replies.removeFirst() }
        val ui = FakeUi()
        val run = AgentRun(api, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Ideas")
        advanceUntilIdle()
        assertEquals(listOf(null, null), ui.steps.single { it.kind == StepKind.IDEAS }.ideas.map { it.image })
        assertEquals("Showed 2 ideas on the phone and the lens: Lean in; Walk. This app shows them as text only.", outputOf(api.requests[1], "show_ideas"))
        assertEquals("ERROR: give at least one idea with a title and a prompt.", outputOf(api.requests[2], "show_ideas"))
    }

    @Test
    fun cancellingWhilePicturingCancelsTheRun() = runTest {
        val replies = ArrayDeque(listOf(reply(call("show_ideas", ideasCall)), reply(call("finish"))))
        lateinit var run: AgentRun
        val api = InspiringApi({ replies.removeFirst() }) { _, _ ->
            launch { run.cancel() }
            CompletableDeferred<String>().await()
        }
        val ui = FakeUi()
        run = AgentRun(api, FakeCamera().tools, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Ideas")
        advanceUntilIdle()
        assertEquals(listOf(Outcome.CANCELLED), ui.ended)
        assertTrue(ui.steps.none { it.kind == StepKind.IDEAS })
    }

    @Test
    fun aMenuSettingSetByHandIsPassedOnUnlessSkipped() = runTest {
        val guide = """{"setting":"HDR Mode","value":"Auto","steps":["Menu","HDR Mode","Auto"]}"""
        val replies = ArrayDeque(listOf(reply(call("menu_steps", guide)), reply(call("menu_steps", guide)), reply(call("finish"))))
        val answers = ArrayDeque(listOf("Done", "Skip"))
        val handSet = mutableListOf<Pair<String, String>>()
        val ui = object : FakeUi() {
            override suspend fun ask(question: String, options: List<String>) = answers.removeFirst()
            override suspend fun handSet(setting: String, value: String) {
                handSet.add(setting to value)
            }
        }
        val api = RecordingApi { replies.removeFirst() }
        val run = AgentRun(api, camera, ui, RunOptions(3, false, { false }, "t"), this)
        run.start("Hold the sky and the shadows")
        advanceUntilIdle()
        assertEquals(listOf("HDR Mode" to "Auto"), handSet)
        assertEquals("The photographer skipped HDR Mode.", outputOf(api.requests[2], "menu_steps"))
    }
}
