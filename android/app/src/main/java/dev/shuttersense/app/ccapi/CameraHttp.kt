package dev.shuttersense.app.ccapi

import dev.shuttersense.app.net.Networks
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Where the camera is and how to reach it. */
data class CameraAddress(
    val host: String,
    val port: Int = 8080,
    val https: Boolean = false,
    val username: String = "",
    val password: String = "",
) {
    val baseUrl: String get() = "${if (https) "https" else "http"}://${host.trim()}:$port"
}

object CameraHttp {
    /**
     * An OkHttp client for the camera only. Cameras serve HTTPS with a
     * self-signed certificate, so certificate checks are switched off here,
     * and only here: the worker client keeps normal TLS.
     */
    private fun client(address: CameraAddress): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            // Event polling can hold the connection for about 10 s.
            .readTimeout(40, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
        if (address.username.isNotEmpty()) {
            val digest = DigestAuth(address.username, address.password)
            b.addInterceptor(digest).authenticator(digest)
        }
        // Over the camera's Wi-Fi even when that network has no internet and isn't the default.
        Networks.forCamera(b, address.host.trim())
        if (address.https) {
            val trustAll = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trustAll), SecureRandom()) }
            b.sslSocketFactory(ssl.socketFactory, trustAll).hostnameVerifier { _, _ -> true }
        }
        return b.build()
    }

    fun transport(address: CameraAddress): CcapiTransport {
        val http = client(address)
        val base = address.baseUrl
        // A stream may stay quiet for longer than any read timeout (no events, live view paused).
        val streaming = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()
        return object : CcapiTransport {
            override suspend fun request(method: String, path: String, body: JsonElement?, headers: Map<String, String>) =
                http.send(base, method, path, body, headers)

            override suspend fun <T> stream(method: String, path: String, read: suspend (StreamResponse) -> T): T =
                streaming.stream(base, method, path, read)
        }
    }
}

private val JSON_TYPE = "application/json".toMediaType()

private fun request(base: String, method: String, path: String, body: JsonElement?, headers: Map<String, String>): Request {
    val reqBody = when {
        body != null -> body.toString().toRequestBody(JSON_TYPE)
        method == "POST" || method == "PUT" -> "{}".toRequestBody(JSON_TYPE)
        else -> null
    }
    val b = Request.Builder().url(base.trimEnd('/') + path).method(method, reqBody)
    for ((k, v) in headers) b.header(k, v)
    return b.build()
}

/** One request, body read off the main thread (OkHttp bodies are blocking streams). */
private suspend fun OkHttpClient.send(base: String, method: String, path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()): RawResponse =
    newCall(request(base, method, path, body, headers)).readResponse { res ->
        val names = res.headers.names().associate { it.lowercase() to res.headers(it).joinToString(", ") }
        RawResponse(res.code, res.header("content-type") ?: "", res.body?.bytes() ?: ByteArray(0), names)
    }

/** A request whose body is handed to [read] as it arrives. */
private suspend fun <T> OkHttpClient.stream(base: String, method: String, path: String, read: suspend (StreamResponse) -> T): T =
    newCall(request(base, method, path, null, emptyMap())).readResponse { res ->
        val body = res.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
        read(StreamResponse(res.code, res.header("content-type") ?: "", body))
    }

/**
 * Runs the call and hands its response to [read] off the main thread, closing
 * it there too (closing a body that wasn't read to its end still reads from
 * the socket). Blocking body reads don't notice coroutine cancellation, so a watcher
 * cancels the call, which makes the read fail and lets [read] return.
 */
suspend fun <T> Call.readResponse(read: suspend (Response) -> T): T = coroutineScope {
    val call = this@readResponse
    // Undispatched, so it is watching before anything can be cancelled.
    val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            call.cancel()
        }
    }
    try {
        withContext(Dispatchers.IO) { call.await().use { res -> read(res) } }
    } catch (e: IOException) {
        // A read failed by the cancel above reports the cancellation, not the IOException.
        ensureActive()
        throw e
    } finally {
        watcher.cancel()
    }
}

/** Suspends until the call completes; cancelling the coroutine cancels the call. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        // A response that arrives after cancellation is closed, not leaked.
        override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, r, _ -> r.close() }
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}

/**
 * HTTP Digest authentication (RFC 2617, MD5, qop=auth), which the camera
 * uses when CCAPI accounts are configured. Answers the 401 challenge, then
 * reuses the challenge for later requests with an increasing nonce count.
 */
class DigestAuth(private val username: String, private val password: String) : Authenticator, Interceptor {
    private data class Challenge(val realm: String, val nonce: String, val opaque: String?, val qop: String?, val algorithm: String?)

    @Volatile private var challenge: Challenge? = null
    private var nc = 0
    private val random = SecureRandom()

    override fun intercept(chain: Interceptor.Chain): Response {
        val c = challenge
        val req = chain.request()
        if (c == null || req.header("Authorization") != null) return chain.proceed(req)
        return chain.proceed(req.newBuilder().header("Authorization", header(c, req)).build())
    }

    override fun authenticate(route: Route?, response: Response): Request? {
        val raw = response.headers("WWW-Authenticate").firstOrNull { it.trim().startsWith("Digest", ignoreCase = true) } ?: return null
        val params = parse(raw.trim().substring(6))
        val c = Challenge(params["realm"] ?: "", params["nonce"] ?: return null, params["opaque"], params["qop"], params["algorithm"])
        val stale = params["stale"].equals("true", ignoreCase = true)
        // Same challenge failed already: the credentials are wrong.
        val prior = response.request.header("Authorization")
        if (prior != null && !stale && prior.contains("nonce=\"${c.nonce}\"")) return null
        if (responseCount(response) >= 3) return null
        synchronized(this) {
            challenge = c
            nc = 0
        }
        return response.request.newBuilder().header("Authorization", header(c, response.request)).build()
    }

    private fun header(c: Challenge, req: Request): String {
        val uri = req.url.encodedPath + (req.url.encodedQuery?.let { "?$it" } ?: "")
        val count = synchronized(this) { ++nc }
        val ncHex = String.format("%08x", count)
        val cnonce = ByteArray(8).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val ha1 = md5("$username:${c.realm}:$password")
        val ha2 = md5("${req.method}:$uri")
        val qop = c.qop?.split(',')?.map { it.trim() }?.firstOrNull { it == "auth" }
        val response = if (qop != null) md5("$ha1:${c.nonce}:$ncHex:$cnonce:$qop:$ha2") else md5("$ha1:${c.nonce}:$ha2")
        return buildString {
            append("Digest username=\"$username\", realm=\"${c.realm}\", nonce=\"${c.nonce}\", uri=\"$uri\", ")
            append("algorithm=${c.algorithm ?: "MD5"}, response=\"$response\"")
            if (qop != null) append(", qop=$qop, nc=$ncHex, cnonce=\"$cnonce\"")
            if (c.opaque != null) append(", opaque=\"${c.opaque}\"")
        }
    }

    private fun responseCount(response: Response): Int {
        var n = 1
        var r = response.priorResponse
        while (r != null) {
            n++
            r = r.priorResponse
        }
        return n
    }

    companion object {
        fun md5(s: String): String = MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

        /** Parses `key="value", key=value` pairs. */
        fun parse(s: String): Map<String, String> {
            val out = mutableMapOf<String, String>()
            Regex("""(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))""").findAll(s).forEach { m ->
                out[m.groupValues[1].lowercase()] = m.groups[2]?.value ?: m.groupValues[3]
            }
            return out
        }
    }
}
