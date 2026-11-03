package dev.shuttersense.app.agent

import dev.shuttersense.app.ccapi.await
import dev.shuttersense.app.net.Networks
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

// Client for the Shutter Sense worker (worker/index.ts): one stateless agent
// step per call, push-to-talk transcription, and session creation for the
// glasses room. The Muse API key lives in the worker, never in the app.

/** What the app tells the worker about the current run (shared/agent-api.ts AgentContext). */
data class AgentContext(
    val goal: String,
    val camera: String,
    val shotsTaken: Int,
    val maxShots: Int,
    val askBeforeShooting: Boolean,
    val glasses: Boolean,
)

data class FunctionCall(val callId: String, val name: String, val arguments: String)

data class AgentResponse(val calls: List<FunctionCall>, val text: String, val commentary: String)

class WorkerException(message: String) : Exception(message)

fun interface AgentApi {
    suspend fun step(session: String, input: List<JsonObject>, context: AgentContext): AgentResponse
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

    private suspend fun post(path: String, body: okhttp3.RequestBody): JsonObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(base + path).post(body).build()
        http.newCall(req).await().use { res ->
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
            })
        }
        val data = post("/api/agent", body.toString().toRequestBody(jsonType))
        val calls = (data["calls"] as? JsonArray)?.mapNotNull { c ->
            val o = c as? JsonObject ?: return@mapNotNull null
            FunctionCall(o.s("call_id") ?: return@mapNotNull null, o.s("name") ?: return@mapNotNull null, o.s("arguments") ?: "{}")
        } ?: emptyList()
        return AgentResponse(calls, data.s("text") ?: "", data.s("commentary") ?: "")
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
