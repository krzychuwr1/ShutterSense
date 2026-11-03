package dev.shuttersense.app.glasses

import dev.shuttersense.app.agent.Idea
import dev.shuttersense.app.agent.MenuScreen
import dev.shuttersense.app.agent.WorkerClient
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
    /** A setting to change by hand on the camera, and the menu path. */
    val guide: HudGuide? = null,
    /** Picture ideas (poses, compositions) to flip through; each image at most IDEA_IMAGE_BYTES. */
    val ideas: List<Idea> = emptyList(),
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
        if (guide != null) {
            put("guide", buildJsonObject {
                put("setting", guide.setting)
                put("steps", buildJsonArray { guide.steps.forEach { add(JsonPrimitive(it)) } })
                put("menu", buildJsonArray { guide.menu.forEach { add(it.toJson()) } })
            })
        } else put("guide", JsonNull)
        put("ideas", buildJsonArray {
            ideas.forEach { idea ->
                add(buildJsonObject {
                    put("title", idea.title)
                    put("direction", idea.direction)
                    put("image", idea.image?.takeIf { it.length <= IDEA_IMAGE_BYTES })
                })
            }
        })
        if (question != null) {
            put("question", buildJsonObject {
                put("text", question)
                put("options", buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
            })
        } else put("question", JsonNull)
    }
}

data class HudGuide(val setting: String, val steps: List<String>, val menu: List<MenuScreen> = emptyList())

/** Largest HUD thumbnail the room accepts (data URL length). */
const val HUD_THUMB_BYTES = 60_000

/** Largest idea picture in a HUD (data URL length); the phone sends small copies to the lens. */
const val IDEA_IMAGE_BYTES = 40_000

enum class RoomState { OFF, CONNECTING, ONLINE }

interface RoomListener {
    fun onState(state: RoomState, glasses: Int)

    /** The arrows the glasses should swipe (U/D/L/R x 8), or null once used. */
    fun onPairing(pattern: String?, expiresInMs: Long)

    /** The wearer dictated something: an instruction, or an answer to a question. */
    fun onSay(text: String)

    /** The room no longer exists (expired, or unknown to the server); the room has stopped. */
    fun onGone()
}

private val SHOOT_REPLY = Regex("""^(shoot|yes|yeah|yep|ok|okay|sure|go|go ahead|take it|do it)\b""")
private val SKIP_REPLY = Regex("""\b(no|nope|skip|don't|do not|stop|wait|not yet|cancel)\b""")

/**
 * A reply to "Take shot n?" (shared/protocol.ts shotReply): true to shoot,
 * false to skip, null when it is neither (a correction, say).
 */
fun shotReply(text: String): Boolean? {
    val t = text.trim().lowercase()
    return when {
        SHOOT_REPLY.containsMatchIn(t) -> true
        SKIP_REPLY.containsMatchIn(t) -> false
        else -> null
    }
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
            // Callbacks arrive on OkHttp's threads; the room's state is only touched in [scope].
            override fun onOpen(webSocket: WebSocket, response: Response) {
                scope.launch { opened(webSocket) }
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

            // The server closed: OkHttp reports onClosed only once we close too, so acknowledge and reconnect now.
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                dropped(webSocket)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // The upgrade was refused: 404 for a room that expired or never existed, 403 for a bad token.
                val code = response?.code
                if (code == 404 || code == 403) gone(webSocket) else dropped(webSocket)
            }
        })
    }

    private fun opened(socket: WebSocket) {
        // A socket replaced or stopped before it opened stays out of it.
        if (socket !== ws || closed) return
        retry = 0
        listener.onState(RoomState.ONLINE, glasses)
        lastHud?.let { hud ->
            socket.send(buildJsonObject {
                put("t", "hud")
                put("hud", hud)
            }.toString())
        }
        ping?.cancel()
        // The room answers "ping" with "pong" without waking up. Ends once the socket stops taking messages.
        ping = scope.launch {
            do delay(20_000) while (socket.send("ping"))
        }
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
                // contentOrNull is null for JSON null too.
                val pattern = (msg["pattern"] as? JsonPrimitive)?.contentOrNull
                listener.onPairing(pattern, (msg["expiresIn"] as? JsonPrimitive)?.longOrNull ?: 0)
            }
        }
    }

    /** Reconnects with backoff. Once per socket: later callbacks for it find [ws] changed. */
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

    /** The room is gone for good: no reconnecting, and the owner is told. */
    private fun gone(socket: WebSocket) {
        scope.launch {
            if (socket !== ws || closed) return@launch
            closed = true
            ping?.cancel()
            ws = null
            listener.onState(RoomState.OFF, 0)
            listener.onGone()
        }
    }
}
