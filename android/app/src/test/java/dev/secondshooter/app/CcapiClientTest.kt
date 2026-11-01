package dev.secondshooter.app

import dev.secondshooter.app.ccapi.CameraAddress
import dev.secondshooter.app.ccapi.CameraHttp
import dev.secondshooter.app.ccapi.CcapiClient
import dev.secondshooter.app.ccapi.CcapiException
import dev.secondshooter.app.ccapi.DigestAuth
import dev.secondshooter.app.ccapi.SettingException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * A small fake camera: a mode dial that software may only override after
 * "ignore dial" is switched on, settings that empty out when the mode doesn't
 * use them, event polling, and contents without a display-size rendition.
 */
class FakeCamera(private val urlStyle: Boolean = false) : Dispatcher() {
    var mode = "av"
    var av = "f5.6"
    var tv = "1/125"
    var ignoreDial = false
    var shots = 0
    val events = ArrayDeque<String>()
    val requests = mutableListOf<String>()
    var authRequired: Pair<String, String>? = null
    private val avList = listOf("f2.8", "f4.0", "f5.6", "f8.0")
    private val tvList = listOf("1/60", "1/125", "1/250", "1/1000")
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)
    private fun msg(code: Int, m: String) = json("""{"message":"$m"}""", code)
    private fun list(xs: List<String>) = xs.joinToString(",", "[", "]") { "\"$it\"" }

    private fun item(name: String): String = when (name) {
        "av" -> if (mode == "av" || mode == "m") """{"value":"$av","ability":${list(avList)}}""" else """{"value":"","ability":[]}"""
        "tv" -> if (mode == "tv" || mode == "m") """{"value":"$tv","ability":${list(tvList)}}""" else """{"value":"","ability":[]}"""
        "colortemperature" -> """{"value":5200,"ability":{"min":2500,"max":10000,"step":100}}"""
        "shootingmodedial" -> """{"value":"$mode","ability":[]}"""
        "shootingmode" -> """{"value":"$mode","ability":["p","av","tv","m"]}"""
        else -> """{"value":"x","ability":["x"]}"""
    }

    private fun entry(path: String, get: Boolean, put: Boolean = false, post: Boolean = false, delete: Boolean = false): String {
        val loc = if (urlStyle) "\"url\":\"http://192.168.1.2:8080$path\"" else "\"path\":\"$path\""
        return """{$loc,"get":$get,"post":$post,"put":$put,"delete":$delete}"""
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.path ?: ""
        val method = request.method ?: "GET"
        requests.add("$method $path")
        authRequired?.let { (user, pass) ->
            val h = request.getHeader("Authorization")
            if (h == null || !h.contains("username=\"$user\"") || !validDigest(h, method, path, user, pass)) {
                return MockResponse().setResponseCode(401)
                    .setHeader("WWW-Authenticate", """Digest realm="CameraControlApi", nonce="abc123", qop="auth", algorithm="MD5", opaque="op1"""")
            }
        }
        val body = request.body.readUtf8()
        val value = runCatching { (Json.parseToJsonElement(body) as JsonObject) }.getOrNull()
        fun str(k: String) = (value?.get(k) as? JsonPrimitive)?.contentOrNull
        return when {
            path == "/ccapi" -> json(
                listOf(
                    "\"ver100\":[" + listOf(
                        entry("/ccapi/ver100/deviceinformation", true),
                        entry("/ccapi/ver100/shooting/settings", true),
                        entry("/ccapi/ver100/shooting/settings/av", true, put = true),
                        entry("/ccapi/ver100/shooting/settings/tv", true, put = true),
                        entry("/ccapi/ver100/shooting/settings/colortemperature", true, put = true),
                        entry("/ccapi/ver100/shooting/settings/shootingmodedial", true),
                        entry("/ccapi/ver100/shooting/control/ignoreshootingmodedialmode", true, post = true),
                        entry("/ccapi/ver100/shooting/control/shutterbutton", false, post = true),
                        entry("/ccapi/ver100/shooting/liveview", false, post = true),
                        entry("/ccapi/ver100/shooting/liveview/flip", true),
                        entry("/ccapi/ver100/event/polling", true, delete = true),
                    ).joinToString(",") + "]",
                    "\"ver110\":[" + listOf(
                        entry("/ccapi/ver110/shooting/settings/shootingmode", true, put = true),
                        entry("/ccapi/ver110/event/polling", true, delete = true),
                    ).joinToString(",") + "]",
                ).joinToString(",", "{", "}"),
            )
            path == "/ccapi/ver100/deviceinformation" -> json("""{"productname":"Fake EOS"}""")
            path == "/ccapi/ver100/shooting/settings" -> json("""{"shootingmodedial":${item("shootingmodedial")},"av":${item("av")},"tv":${item("tv")},"colortemperature":${item("colortemperature")}}""")
            path == "/ccapi/ver110/shooting/settings/shootingmode" && method == "GET" -> json(item("shootingmode"))
            path == "/ccapi/ver110/shooting/settings/shootingmode" && method == "PUT" ->
                if (!ignoreDial) msg(503, "Mode not supported") else {
                    mode = str("value") ?: mode
                    json("""{"value":"$mode"}""")
                }
            path == "/ccapi/ver100/shooting/control/ignoreshootingmodedialmode" && method == "POST" -> {
                ignoreDial = str("action") == "on"
                json("{}")
            }
            path.startsWith("/ccapi/ver100/shooting/settings/") && method == "GET" -> json(item(path.substringAfterLast('/')))
            path.startsWith("/ccapi/ver100/shooting/settings/") && method == "PUT" -> {
                when (path.substringAfterLast('/')) {
                    "av" -> av = str("value") ?: av
                    "tv" -> tv = str("value") ?: tv
                }
                json(body)
            }
            path == "/ccapi/ver100/shooting/control/shutterbutton" -> {
                shots++
                events.addLast("""{"addedcontents":["http://192.168.1.2:8080/ccapi/ver110/contents/card1/100CANON/IMG_000$shots.JPG"],"effective_value_tv":{"value":"1/500"}}""")
                json("{}")
            }
            path.startsWith("/ccapi/ver110/event/polling") -> json(events.removeFirstOrNull() ?: "{}")
            path.startsWith("/ccapi/ver100/event/polling") -> json("""{"wrongversion":true}""")
            path == "/ccapi/ver100/shooting/liveview" && method == "POST" -> json("{}")
            path == "/ccapi/ver100/shooting/liveview/flip" -> msg(503, "Live view not started")
            path.endsWith("?kind=display") -> msg(400, "Illegal query parameter")
            path.endsWith("?kind=main") -> MockResponse().setHeader("content-type", "image/jpeg").setBody(Buffer().write(jpeg))
            else -> msg(404, "URL not found")
        }
    }

    private fun validDigest(h: String, method: String, uri: String, user: String, pass: String): Boolean {
        val p = DigestAuth.parse(h.removePrefix("Digest "))
        val ha1 = DigestAuth.md5("$user:CameraControlApi:$pass")
        val ha2 = DigestAuth.md5("$method:$uri")
        val expected = DigestAuth.md5("$ha1:${p["nonce"]}:${p["nc"]}:${p["cnonce"]}:${p["qop"]}:$ha2")
        return p["response"] == expected && p["uri"] == uri && p["opaque"] == "op1"
    }
}

class CcapiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var camera: FakeCamera

    private fun client(cam: FakeCamera = camera, user: String = "", pass: String = ""): CcapiClient {
        server.dispatcher = cam
        val url = server.url("/")
        return CcapiClient(CameraHttp.transport(CameraAddress(url.host, url.port, false, user, pass)))
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        camera = FakeCamera()
    }

    @After
    fun tearDown() = server.shutdown()

    @Test
    fun discoveryRoutesToTheHighestVersion() = runBlocking {
        val c = client()
        c.discover()
        assertEquals("/ccapi/ver110/event/polling", c.endpoint("event/polling"))
        assertEquals("/ccapi/ver110/shooting/settings/shootingmode", c.endpoint("shooting/settings/shootingmode", "put"))
        assertEquals("/ccapi/ver100/shooting/settings/av", c.endpoint("shooting/settings/av", "put"))
        assertFalse(c.has("shooting/settings/shootingmodedial", "put"))
    }

    @Test
    fun discoveryAcceptsAbsoluteUrls() = runBlocking {
        val c = client(FakeCamera(urlStyle = true))
        c.discover()
        assertEquals("/ccapi/ver100/shooting/settings/av", c.endpoint("shooting/settings/av", "put"))
    }

    @Test
    fun settingsMergeAndEmptyOutByMode() = runBlocking {
        val c = client()
        c.discover()
        val s = c.settings()
        assertEquals("av", s["shootingmode"]?.text)
        assertEquals("", s["tv"]?.text)
        assertFalse(s["tv"]!!.changeable)
        assertTrue(s["av"]!!.changeable)
    }

    @Test
    fun invalidValuesComeBackWithTheOptions() = runBlocking {
        val c = client()
        c.discover()
        try {
            c.set("av", "f1.4")
            fail("expected a rejection")
        } catch (e: SettingException) {
            assertEquals("av = \"f1.4\" is not accepted. Options: f2.8, f4.0, f5.6, f8.0.", e.message)
        }
        try {
            c.set("tv", "1/1000")
            fail("expected a rejection")
        } catch (e: SettingException) {
            assertEquals("tv can't be changed in the current shooting mode.", e.message)
        }
        try {
            c.set("colortemperature", 3150)
            fail("expected a rejection")
        } catch (e: SettingException) {
            assertEquals("colortemperature must be a whole number from 2500 to 10000 in steps of 100.", e.message)
        }
        // Nothing invalid was sent to the camera.
        assertTrue(camera.requests.none { it.startsWith("PUT") })
    }

    @Test
    fun modeChangeTurnsOnIgnoreDialAndRetries() = runBlocking {
        val c = client()
        c.discover()
        c.setMode("tv")
        assertEquals("tv", camera.mode)
        assertTrue(camera.ignoreDial)
        c.set("tv", "1/1000")
        assertEquals("1/1000", camera.tv)
        val puts = camera.requests.filter { it.startsWith("PUT /ccapi/ver110/shooting/settings/shootingmode") }
        assertEquals(2, puts.size)
    }

    @Test
    fun shootThenFindTheFileInPollingAndFallBackToMain() = runBlocking {
        val c = client()
        c.discover()
        c.shutter(true)
        val seen = mutableListOf<JsonObject>()
        val path = c.waitForNewFile(5_000) { seen.add(it) }
        assertEquals("/ccapi/ver110/contents/card1/100CANON/IMG_0001.JPG", path)
        assertTrue(seen.any { "effective_value_tv" in it })
        assertTrue(camera.requests.any { it == "GET /ccapi/ver110/event/polling?timeout=short" })
        val bytes = c.download(path)
        assertArrayEquals(camera.jpeg, bytes)
        assertTrue(camera.requests.contains("GET $path?kind=display"))
        assertTrue(camera.requests.contains("GET $path?kind=main"))
    }

    @Test
    fun liveViewIsStartedWhenNeededAndErrorsKeepTheirMessage() = runBlocking {
        val c = client()
        c.discover()
        try {
            c.liveFrame()
            fail("the fake never serves frames")
        } catch (e: CcapiException) {
            assertEquals(503, e.status)
            assertEquals("Live view not started", e.message)
        }
        assertTrue(camera.requests.any { it.startsWith("POST /ccapi/ver100/shooting/liveview") })
    }

    @Test
    fun digestAuthAnswersTheChallenge() = runBlocking {
        camera.authRequired = "user" to "secret"
        val c = client(user = "user", pass = "secret")
        c.discover()
        assertEquals("Fake EOS", c.deviceInfo()["productname"])
    }

    @Test
    fun wrongPasswordFails() = runBlocking {
        camera.authRequired = "user" to "secret"
        val c = client(user = "user", pass = "nope")
        try {
            c.discover()
            fail("expected 401")
        } catch (e: CcapiException) {
            assertEquals(401, e.status)
        }
    }
}
