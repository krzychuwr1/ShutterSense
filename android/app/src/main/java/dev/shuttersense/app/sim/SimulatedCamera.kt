package dev.shuttersense.app.sim

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import dev.shuttersense.app.ccapi.CcapiTransport
import dev.shuttersense.app.ccapi.RawResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

// The camera simulator running on the phone, for demos without a camera or a
// computer. The TypeScript simulator (camsim/) is bundled into the APK as a
// small web page (web/sim-host, built into assets/sim) with the scene images
// next to it (assets/sim/scenes, copied from web/public/scenes by Gradle). It
// runs in a WebView that is never shown; the page keeps the camera in a web
// worker.
//
// Bridge: a request is a call to `simRequest(id, method, path, body, headers)`
// in the page (evaluateJavascript, on the main thread); the answer comes back
// on WebView's bridge thread through `SimBridge.respond(id, status,
// contentType, headersJson, base64Body)` and completes the waiting coroutine.
// Status 0 means the simulated camera left the network, which the transport
// reports as a dropped connection, like the real camera's.

data class SimScene(val id: String, val title: String, val blurb: String, val goals: List<String>)

class SimulatedCamera(context: Context) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val startLock = Mutex()

    /** The running page, or null before [start] and after [close]. */
    @Volatile
    private var host: Host? = null

    /** Bumped by [close], so a start that was under way when it happened gives up. */
    @Volatile
    private var generation = 0

    private val seq = AtomicInteger()

    /**
     * Loads the simulator (the page, then the first scene's images); returns
     * once it answers requests. Throws if it can't start. Safe to call twice,
     * and again after [close] to bring it back.
     */
    suspend fun start() = startLock.withLock {
        if (host != null) return@withLock
        val gen = generation
        val h = withContext(Dispatchers.Main) { Host(createWebView()) }
        try {
            withTimeout(START_TIMEOUT_MS) { h.ready.await() }
        } catch (e: Throwable) {
            withContext(NonCancellable + Dispatchers.Main) { h.destroy(IOException("The simulator didn't start")) }
            if (e is TimeoutCancellationException) throw IllegalStateException("The simulator didn't start within ${START_TIMEOUT_MS / 1000} s")
            throw e
        }
        if (gen != generation) {
            withContext(NonCancellable + Dispatchers.Main) { h.destroy(IOException("The simulator was closed")) }
            throw IllegalStateException("The simulator was closed while starting")
        }
        host = h
    }

    /**
     * CCAPI requests to the simulated camera, for [dev.shuttersense.app.ccapi.CcapiClient].
     * Usable from any thread or dispatcher once [start] has returned; before
     * that (and after [close]) requests fail with an IOException, like an
     * unreachable camera.
     */
    val transport: CcapiTransport = CcapiTransport { method, path, body, headers -> call(method, path, body, headers) }

    /** The scenes the simulator offers, with suggested goals. Starts the simulator if needed. */
    suspend fun scenes(): List<SimScene> {
        start()
        val list = json(call("GET", "/sim/scenes")) as? JsonArray ?: return emptyList()
        return list.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            SimScene(o.str("id"), o.str("title"), o.str("blurb"), (o["goals"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList())
        }
    }

    /** The current scene's id. Starts the simulator if needed. */
    suspend fun scene(): String {
        start()
        return (json(call("GET", "/sim/status")) as? JsonObject)?.str("scene").orEmpty()
    }

    /** Switches scene; the camera's settings go back to that scene's starting point. Starts the simulator if needed. */
    suspend fun setScene(id: String) {
        start()
        val res = call("POST", "/sim/scene", JsonObject(mapOf("id" to JsonPrimitive(id))))
        if (res.status != 200) {
            val message = (json(res) as? JsonObject)?.str("message")
            throw IllegalArgumentException("Can't switch to scene \"$id\": ${message ?: "status ${res.status}"}")
        }
    }

    /**
     * A JPEG for the scene picker, straight from the APK (no need to start the
     * simulator). Scenes without a picker image get a reduced copy of their
     * background layer.
     */
    suspend fun thumbnail(id: String): ByteArray = withContext(Dispatchers.IO) {
        require(SCENE_ID.matches(id)) { "Bad scene id \"$id\"" }
        try {
            app.assets.open("$SCENES/$id.jpg").use { it.readBytes() }
        } catch (_: FileNotFoundException) {
            val plate = app.assets.list("$SCENES/$id")?.sorted()?.firstOrNull { it.endsWith(".jpg") }
                ?: throw FileNotFoundException("No images for scene \"$id\"")
            val bitmap = app.assets.open("$SCENES/$id/$plate").use {
                BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = 4 })
            } ?: throw IOException("Can't decode $plate of scene \"$id\"")
            ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it); bitmap.recycle() }.toByteArray()
        }
    }

    /** Stops the simulator and frees the WebView; requests still waiting fail. Callable from any thread. */
    fun close() {
        generation++
        val h = host ?: return
        host = null
        val gone = IOException("The simulator was closed")
        h.failAll(gone)
        if (Looper.myLooper() == Looper.getMainLooper()) h.destroy(gone) else main.post { h.destroy(gone) }
    }

    private suspend fun call(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()): RawResponse {
        val h = host ?: throw IOException("The simulator isn't running")
        val id = seq.incrementAndGet()
        val done = CompletableDeferred<RawResponse>()
        h.pending[id] = done
        if (host !== h) {
            // Closed (or the renderer died) in the meantime: nobody will answer.
            h.pending.remove(id)
            throw IOException("The simulator isn't running")
        }
        val headersJs = JsonObject(headers.mapValues { JsonPrimitive(it.value) })
        val js = "simRequest($id,${JsonPrimitive(method)},${JsonPrimitive(path)},${body ?: "null"},$headersJs)"
        main.post { h.evaluate(js) }
        try {
            return withTimeout(REQUEST_TIMEOUT_MS) { done.await() }
        } catch (_: TimeoutCancellationException) {
            throw IOException("The simulator didn't answer $method $path")
        } finally {
            h.pending.remove(id)
        }
    }

    private fun json(res: RawResponse): JsonElement? =
        if (res.body.isEmpty()) null else Json.parseToJsonElement(res.body.decodeToString())

    private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView = WebView(app).apply {
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        // Keep the renderer at foreground importance even though the view is never on screen.
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    }

    /** One loaded page: its WebView, the bridge object and the requests waiting for it. */
    private inner class Host(private val view: WebView) {
        val ready = CompletableDeferred<Unit>()
        val pending = ConcurrentHashMap<Int, CompletableDeferred<RawResponse>>()

        @Volatile
        private var destroyed = false

        init {
            val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(app)).build()
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse =
                    // Only the APK's assets: the simulator never goes to the network.
                    assets.shouldInterceptRequest(request.url) ?: notFound()

                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest) = true

                override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) fail("Can't load the simulator page: ${error.description}")
                }

                override fun onReceivedHttpError(v: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (request.isForMainFrame) fail("Can't load the simulator page: HTTP ${response.statusCode}")
                }

                override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                    // Without this the app would crash with the renderer. The simulator is gone; start() makes a new one.
                    Log.w(TAG, "Simulator renderer gone (crash: ${detail.didCrash()})")
                    if (host === this@Host) host = null
                    val gone = IOException("The simulator stopped")
                    fail(gone.message!!)
                    failAll(gone)
                    destroy(gone)
                    return true
                }
            }
            view.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "${m.messageLevel()}: ${m.message()}")
                    return true
                }
            }
            view.addJavascriptInterface(Bridge(), "SimBridge")
            view.loadUrl(PAGE)
        }

        private fun fail(message: String) {
            ready.completeExceptionally(IllegalStateException(message))
        }

        fun failAll(e: IOException) {
            pending.values.forEach { it.completeExceptionally(e) }
            pending.clear()
        }

        /** Main thread only. */
        fun evaluate(js: String) {
            if (!destroyed) view.evaluateJavascript(js, null)
        }

        /** Main thread only. */
        fun destroy(e: IOException) {
            failAll(e)
            if (destroyed) return
            destroyed = true
            view.stopLoading()
            view.destroy()
        }

        /** Called by the page, on WebView's bridge thread. */
        inner class Bridge {
            @JavascriptInterface
            fun ready() {
                ready.complete(Unit)
            }

            @JavascriptInterface
            fun fail(message: String) {
                Log.w(TAG, "Simulator failed to start: $message")
                this@Host.fail(message)
            }

            @JavascriptInterface
            fun respond(id: Int, status: Int, contentType: String, headersJson: String, base64Body: String) {
                val done = pending.remove(id) ?: return
                if (status == 0) {
                    done.completeExceptionally(IOException("The connection to the camera was lost"))
                    return
                }
                try {
                    val headers = (Json.parseToJsonElement(headersJson) as? JsonObject)
                        ?.mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull.orEmpty() } ?: emptyMap()
                    done.complete(RawResponse(status, contentType, Base64.getDecoder().decode(base64Body), headers))
                } catch (e: Exception) {
                    done.completeExceptionally(IOException("Bad answer from the simulator", e))
                }
            }
        }
    }

    companion object {
        private const val TAG = "SimulatedCamera"
        private const val PAGE = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/sim/index.html"
        private const val SCENES = "sim/scenes"
        private val SCENE_ID = Regex("^[a-z0-9_-]+$")

        /** The page plus decoding the first scene's layers. */
        private const val START_TIMEOUT_MS = 30_000L

        /** Long enough for a long event poll (30 s) or a long exposure. */
        private const val REQUEST_TIMEOUT_MS = 90_000L

        private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
