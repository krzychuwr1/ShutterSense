package dev.shuttersense.app.agent

import dev.shuttersense.app.ccapi.readResponse
import dev.shuttersense.app.net.Networks
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// Client for the Shutter Sense worker (worker/index.ts): one stateless agent
// step per call, idea pictures, push-to-talk transcription, and session
// creation for the glasses room. The Muse API key lives in the worker, never
// in the app.

/** What the app tells the worker about the current run (shared/agent-api.ts AgentContext). */
data class AgentContext(
    val goal: String,
    val camera: String,
    val shotsTaken: Int,
    val maxShots: Int,
    val askBeforeShooting: Boolean,
    val glasses: Boolean,
    /** The photographer's saved presets, for apply_preset. */
    val presets: List<PresetSummary> = emptyList(),
)

/**
 * One picture idea from show_ideas: a pose, composition or angle, with what
 * to tell the subject, and a generated picture of it (null if the image model
 * failed; the idea still shows as text).
 */
data class Idea(
    val title: String,
    /** What to tell the people in the photo, or where to stand. */
    val direction: String,
    /** JPEG data URL. */
    val image: String?,
)

/** show_ideas limits (shared/agent-api.ts INSPIRE_LIMITS). */
const val INSPIRE_PROMPT = 600
const val INSPIRE_IDEAS = 4
const val INSPIRE_TITLE = 40
const val INSPIRE_DIRECTION = 120

data class FunctionCall(val callId: String, val name: String, val arguments: String)

data class AgentResponse(val calls: List<FunctionCall>, val text: String, val commentary: String)

class WorkerException(message: String) : Exception(message)

fun interface AgentApi {
    suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse

    /** Whether [inspire] makes pictures. Without it, show_ideas shows the ideas as text. */
    val canInspire: Boolean get() = false

    /**
     * One idea picture (POST /api/inspire) for [prompt], re-imagining [image]
     * (a live-view JPEG data URL) when given. Returns a PNG or JPEG data URL.
     */
    suspend fun inspire(session: String, prompt: String, image: String?): String = throw WorkerException("This app can't make pictures")
}

data class NewSession(val code: String, val token: String)

class WorkerClient(baseUrl: String) : AgentApi {
    val base = baseUrl.trim().trimEnd('/')
    // Over a network that reaches the internet: mobile data while the phone sits on a camera's offline Wi-Fi.
    private val http = Networks.forInternet(OkHttpClient.Builder(), base.toHttpUrlOrNull()?.host ?: "")
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    private suspend fun post(path: String, body: okhttp3.RequestBody): JsonObject {
        val req = Request.Builder().url(base + path).post(body).build()
        // Cancelling the run cancels the call, while the answer is still being read too.
        return http.newCall(req).readResponse { res ->
            val text = res.body?.string() ?: ""
            val data = try {
                Json.parseToJsonElement(text) as? JsonObject
            } catch (_: Exception) {
                null
            }
            if (!res.isSuccessful) {
                val msg = (data?.get("error") as? JsonPrimitive)?.contentOrNull
                throw WorkerException(msg ?: "The server answered ${res.code}")
            }
            data ?: throw WorkerException("The server sent an unexpected answer")
        }
    }

    override suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse {
        val body = buildJsonObject {
            put("session", session)
            put("input", JsonArray(input))
            put("context", buildJsonObject {
                put("goal", context.goal)
                put("camera", context.camera)
                put("shotsTaken", context.shotsTaken)
                put("maxShots", context.maxShots)
                put("askBeforeShooting", context.askBeforeShooting)
                put("glasses", context.glasses)
                put("presets", buildJsonArray {
                    context.presets.forEach { p ->
                        add(buildJsonObject {
                            put("name", p.name)
                            put("note", p.note)
                            put("settings", p.settings)
                        })
                    }
                })
            })
        }
        val data = post("/api/agent", body.toString().toRequestBody(jsonType))
        val calls = (data["calls"] as? JsonArray)?.mapNotNull { c ->
            val o = c as? JsonObject ?: return@mapNotNull null
            FunctionCall(o.s("call_id") ?: return@mapNotNull null, o.s("name") ?: return@mapNotNull null, o.s("arguments") ?: "{}")
        } ?: emptyList()
        return AgentResponse(calls, data.s("text") ?: "", data.s("commentary") ?: "")
    }

    override val canInspire: Boolean get() = true

    override suspend fun inspire(session: String, prompt: String, image: String?): String {
        val body = buildJsonObject {
            put("session", session)
            put("prompt", prompt)
            if (image != null) put("image", image)
        }
        val data = post("/api/inspire", body.toString().toRequestBody(jsonType))
        return data.s("image")?.takeIf { it.isNotEmpty() } ?: throw WorkerException("No picture came back")
    }

    /** Push-to-talk: 16-bit mono WAV in, text out. */
    suspend fun transcribe(wav: ByteArray): String {
        val data = post("/api/transcribe", wav.toRequestBody("audio/wav".toMediaType()))
        return data.s("text") ?: ""
    }

    suspend fun createSession(): NewSession {
        val data = post("/api/rooms", ByteArray(0).toRequestBody(jsonType))
        return NewSession(data.s("code") ?: throw WorkerException("No session code"), data.s("token") ?: throw WorkerException("No session token"))
    }

    fun webSocketUrl(code: String, token: String): String {
        val ws = base.replaceFirst(Regex("^http"), "ws")
        return "$ws/api/rooms/$code/ws?role=phone&token=${java.net.URLEncoder.encode(token, "UTF-8")}"
    }

    val socketClient: OkHttpClient get() = http
}

private fun JsonObject.s(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
