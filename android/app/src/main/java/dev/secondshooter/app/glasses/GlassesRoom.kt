package dev.secondshooter.app.glasses

import dev.secondshooter.app.agent.WorkerClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Everything the lens shows (shared/protocol.ts HudState). The phone sends a fresh copy whenever it changes. */
data class HudState(
    val phase: String = "idle",
    val goal: String? = null,
    val step: String = "",
    val shotsTaken: Int = 0,
    val shotsMax: Int = 0,
    val diff: List<String> = emptyList(),
    /** Last shot as a small JPEG data URL (at most HUD_THUMB_BYTES). */
    val thumb: String? = null,
    val exposure: String? = null,
    val message: String? = null,
    val summary: String? = null,
    val question: String? = null,
    val options: List<String> = emptyList(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("phase", phase)
        put("goal", goal)
        put("step", step)
        put("shots", buildJsonObject {
            put("taken", shotsTaken)
            put("max", shotsMax)
        })
        put("diff", buildJsonArray { diff.forEach { add(JsonPrimitive(it)) } })
        put("thumb", thumb?.takeIf { it.length <= HUD_THUMB_BYTES })
        put("exposure", exposure)
        put("message", message)
        put("summary", summary)
        if (question != null) {
            put("question", buildJsonObject {
                put("text", question)
                put("options", buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
            })
        } else put("question", JsonNull)
    }
}

/** Largest HUD thumbnail the room accepts (data URL length). */
const val HUD_THUMB_BYTES = 60_000

enum class RoomState { OFF, CONNECTING, ONLINE }

interface RoomListener {
    fun onState(state: RoomState, glasses: Int)

    /** The arrows the glasses should swipe (U/D/L/R x 8), or null once used. */
    fun onPairing(pattern: String?, expiresInMs: Long)

    /** The wearer dictated something: an instruction, or an answer to a question. */
    fun onSay(text: String)
}

/**
 * The phone's side of the glasses room: one WebSocket to the session's
 * Durable Object. Sends the HUD, asks for pairing patterns, receives what the
 * wearer dictates. Reconnects with backoff.
 */
class GlassesRoom(
    private val worker: WorkerClient,
    val code: String,
    private val token: String,
    private val scope: CoroutineScope,
    private val listener: RoomListener,
) {
    private var ws: WebSocket? = null
    private var lastHud: JsonObject? = null
    private var retry = 0
    private var closed = false
    private var ping: Job? = null
    var glasses = 0
        private set

    fun start() {
        closed = false
        connect()
    }

    fun stop() {
        closed = true
        ping?.cancel()
        ws?.close(1000, "bye")
        ws = null
        listener.onState(RoomState.OFF, 0)
    }

    fun sendHud(hud: HudState) {
        val json = hud.toJson()
        if (json == lastHud) return
        lastHud = json
        send(buildJsonObject {
            put("t", "hud")
            put("hud", json)
        })
    }

    fun requestPairing() = send(buildJsonObject { put("t", "pair") })

    private fun send(msg: JsonObject) {
        ws?.send(msg.toString())
    }

    private fun connect() {
        listener.onState(RoomState.CONNECTING, glasses)
        val req = Request.Builder().url(worker.webSocketUrl(code, token)).build()
        ws = worker.socketClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retry = 0
                listener.onState(RoomState.ONLINE, glasses)
                lastHud?.let { hud ->
                    webSocket.send(buildJsonObject {
                        put("t", "hud")
                        put("hud", hud)
                    }.toString())
                }
                ping?.cancel()
                // The room answers "ping" with "pong" without waking up.
                ping = scope.launch {
                    while (true) {
                        delay(20_000)
                        webSocket.send("ping")
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text == "pong") return
                val msg = try {
                    Json.parseToJsonElement(text) as? JsonObject
                } catch (_: Exception) {
                    null
                } ?: return
                scope.launch { handle(msg) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
        })
    }

    private fun handle(msg: JsonObject) {
        when ((msg["t"] as? JsonPrimitive)?.contentOrNull) {
            "hello", "presence" -> {
                val presence = msg["presence"] as? JsonObject
                glasses = (presence?.get("glasses") as? JsonPrimitive)?.intOrNull ?: glasses
                listener.onState(RoomState.ONLINE, glasses)
            }
            "say" -> (msg["text"] as? JsonPrimitive)?.contentOrNull?.let { listener.onSay(it) }
            "pairing" -> {
                val p = msg["pattern"] as? JsonPrimitive
                val pattern = if (p == null || p is JsonNull) null else p.contentOrNull
                listener.onPairing(pattern, (msg["expiresIn"] as? JsonPrimitive)?.longOrNull ?: 0)
            }
        }
    }

    private fun dropped(socket: WebSocket) {
        scope.launch {
            if (socket !== ws || closed) return@launch
            ping?.cancel()
            ws = null
            listener.onState(RoomState.CONNECTING, glasses)
            delay(minOf(10_000L, 500L shl minOf(retry++, 5)))
            if (!closed) connect()
        }
    }
}
