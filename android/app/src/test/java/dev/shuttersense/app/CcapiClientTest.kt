package dev.shuttersense.app

import dev.shuttersense.app.ccapi.CameraAddress
import dev.shuttersense.app.ccapi.CameraHttp
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.ccapi.CcapiException
import dev.shuttersense.app.ccapi.ContentsCount
import dev.shuttersense.app.ccapi.DigestAuth
import dev.shuttersense.app.ccapi.RECORD_EVENT
import dev.shuttersense.app.ccapi.RECORD_INFO
import dev.shuttersense.app.ccapi.RECORD_JPEG
import dev.shuttersense.app.ccapi.SettingException
import dev.shuttersense.app.ccapi.detailFrames
import dev.shuttersense.app.ccapi.formatCameraDate
import dev.shuttersense.app.ccapi.parseJsonSequence
import dev.shuttersense.app.ccapi.parseMultipart
import dev.shuttersense.app.ccapi.parseRecords
import dev.shuttersense.app.ccapi.splitJpegs
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.time.Instant

/** A framed record: FF 00 <type> <size> <data> FF FF, the size big- or little-endian. */
fun record(type: Int, data: ByteArray, bigEndian: Boolean = true): ByteArray {
    val out = ByteArrayOutputStream()
    out.write(0xFF)
    out.write(0x00)
    out.write(type)
    val n = data.size
    val size = listOf(n ushr 24, n ushr 16, n ushr 8, n).map { it and 0xFF }
    (if (bigEndian) size else size.reversed()).forEach(out::write)
    out.write(data)
    out.write(0xFF)
    out.write(0xFF)
    return out.toByteArray()
}

/**
 * A small fake camera: a mode dial that software may only override after
 * "ignore dial" is switched on, settings that empty out when the mode doesn't
 * use them, composite settings (white balance shift, image quality, picture
 * style detail), live view detail records and streams, event polling and
 * monitoring, focus control, the clock, and a card of 150 files that can be
 * paged, read in ranges, protected, rated and deleted. Contents under ver110
 * have no display-size rendition.
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

    // Composite settings.
    var wbshift = mapOf("ba" to 0, "mg" to 0)
    var quality = mapOf("raw" to "none", "jpeg" to "large")
    private val styleDefaults = mapOf(
        "sharpness_strength" to 4, "sharpness_fineness" to 2, "sharpness_threshold" to 2,
        "contrast" to 0, "saturation" to 0, "colortone" to 0,
    )
    var standard = styleDefaults
    var userdef1 = mapOf("contrast" to 0)
    val putBodies = mutableListOf<String>()

    // Focus, clock.
    var afX = 3000
    var afY = 2000
    val focusSteps = mutableListOf<String>()
    var datetime = "Mon, 01 Jan 2024 00:00:00 +0000"
    var dst = false

    // The card: 150 files of 1000 bytes in 100CANON.
    class File(val name: String, var protect: Boolean = false, var rating: String = "off") {
        val bytes = ByteArray(1000) { (it % 251).toByte() }
    }
    val dirPath = "/ccapi/ver120/contents/card1/100CANON"
    val files = (1..150).map { File("IMG_%04d.JPG".format(it)) }.toMutableList()
    var lastRange: String? = null

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)
    private fun msg(code: Int, m: String) = json("""{"message":"$m"}""", code)
    private fun list(xs: List<String>) = xs.joinToString(",", "[", "]") { "\"$it\"" }
    private fun obj(m: Map<String, Any>) = m.entries.joinToString(",", "{", "}") { (k, v) -> "\"$k\":" + if (v is String) "\"$v\"" else "$v" }
    private fun binary(bytes: ByteArray, type: String = "application/octet-stream") = MockResponse().setHeader("content-type", type).setBody(Buffer().write(bytes))

    private fun item(name: String): String = compositeItem(name) ?: when (name) {
        "av" -> if (mode == "av" || mode == "m") """{"value":"$av","ability":${list(avList)}}""" else """{"value":"","ability":[]}"""
        "tv" -> if (mode == "tv" || mode == "m") """{"value":"$tv","ability":${list(tvList)}}""" else """{"value":"","ability":[]}"""
        "colortemperature" -> """{"value":5200,"ability":{"min":2500,"max":10000,"step":100}}"""
        "shootingmodedial" -> """{"value":"$mode","ability":[]}"""
        "shootingmode" -> """{"value":"$mode","ability":["p","av","tv","m"]}"""
        else -> """{"value":"x","ability":["x"]}"""
    }

    private val compositeKeys = listOf("wbshift", "stillimagequality", "picturestyle/standard", "picturestyle/userdef1")

    private fun compositeItem(name: String): String? {
        fun r(min: Int, max: Int) = """{"min":$min,"max":$max,"step":1}"""
        return when (name) {
            "wbshift" -> """{"value":${obj(wbshift)},"ability":{"ba":${r(-9, 9)},"mg":${r(-9, 9)}}}"""
            "stillimagequality" -> """{"value":${obj(quality)},"ability":{"raw":${list(listOf("none", "raw", "craw"))},"jpeg":${list(listOf("large", "middle", "small1", "none"))}}}"""
            "picturestyle/standard" ->
                """{"value":${obj(standard)},"ability":{"sharpness_strength":${r(0, 7)},"sharpness_fineness":${r(1, 5)},"sharpness_threshold":${r(1, 5)},""" +
                    """"contrast":${r(-4, 4)},"saturation":${r(-4, 4)},"colortone":${r(-4, 4)}}}"""
            // A user style: its base style is read-only (empty list).
            "picturestyle/userdef1" -> """{"value":${obj(mapOf("basepicturestyle" to "landscape") + userdef1)},"ability":{"basepicturestyle":[],"contrast":${r(-4, 4)}}}"""
            else -> null
        }
    }

    /** Incidental info: histograms of 6000 pixels, the AF frame where it was put, the sensor area. */
    private fun liveInfo(): ByteArray {
        fun bins(at: Int) = (0 until 256).joinToString(",", "[", "]") { if (it == at) "6000" else "0" }
        return ("""{"liveviewdata":{"histogram":[${bins(128)},${bins(100)},${bins(128)},${bins(160)}],""" +
            """"afframe":[{"status":1,"select":1,"x":$afX,"y":$afY,"width":200,"height":200}],""" +
            """"image":{"positionx":0,"positiony":0,"positionwidth":6000,"positionheight":4000,"sizex":6000,"sizey":4000},""" +
            """"zoom":{"magnification":1,"positionx":0,"positiony":0,"positionwidth":600,"positionheight":400}}}""").toByteArray()
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
        val setting = path.removePrefix("/ccapi/ver100/shooting/settings/")
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
                        entry("/ccapi/ver100/shooting/settings/wbshift", true, put = true),
                        entry("/ccapi/ver100/shooting/settings/stillimagequality", true, put = true),
                        entry("/ccapi/ver100/shooting/settings/picturestyle/standard", true, put = true, delete = true),
                        entry("/ccapi/ver100/shooting/settings/picturestyle/userdef1", true, put = true, delete = true),
                        entry("/ccapi/ver100/shooting/control/ignoreshootingmodedialmode", true, post = true),
                        entry("/ccapi/ver100/shooting/control/shutterbutton", false, post = true),
                        entry("/ccapi/ver100/shooting/control/drivefocus", false, post = true),
                        entry("/ccapi/ver100/shooting/liveview", false, post = true),
                        entry("/ccapi/ver100/shooting/liveview/flip", true),
                        entry("/ccapi/ver100/shooting/liveview/flipdetail", true),
                        entry("/ccapi/ver100/shooting/liveview/scrolldetail", true, delete = true),
                        entry("/ccapi/ver100/shooting/liveview/multipart", true, delete = true),
                        entry("/ccapi/ver100/shooting/liveview/afframeposition", false, put = true),
                        entry("/ccapi/ver100/functions/datetime", true, put = true),
                        entry("/ccapi/ver100/functions/cardformat", false, post = true),
                        entry("/ccapi/ver100/event/polling", true, delete = true),
                        entry("/ccapi/ver100/event/monitoring", true, delete = true),
                    ).joinToString(",") + "]",
                    "\"ver110\":[" + listOf(
                        entry("/ccapi/ver110/shooting/settings/shootingmode", true, put = true),
                        entry("/ccapi/ver110/event/polling", true, delete = true),
                    ).joinToString(",") + "]",
                    "\"ver120\":[" + listOf(
                        entry("/ccapi/ver120/contents", true),
                    ).joinToString(",") + "]",
                ).joinToString(",", "{", "}"),
            )
            path == "/ccapi/ver100/deviceinformation" -> json("""{"productname":"Fake EOS","munufacturer":"Fake"}""")
            path == "/ccapi/ver100/shooting/settings" -> json(
                """{"shootingmodedial":${item("shootingmodedial")},"av":${item("av")},"tv":${item("tv")},"colortemperature":${item("colortemperature")},""" +
                    """"wbshift":${item("wbshift")},"picturestyle_standard":${item("picturestyle/standard")}}""",
            )
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
            setting in compositeKeys && method == "PUT" -> {
                putBodies.add(body)
                val v = value?.get("value") as? JsonObject ?: return msg(400, "Invalid parameter")
                fun ints() = v.mapValues { it.value.jsonPrimitive.int }
                when (setting) {
                    "wbshift" -> wbshift = ints()
                    "stillimagequality" -> quality = v.mapValues { it.value.jsonPrimitive.content }
                    "picturestyle/standard" -> standard = ints()
                    "picturestyle/userdef1" -> if ("basepicturestyle" in v) return msg(400, "Invalid parameter") else userdef1 = ints()
                }
                json(body)
            }
            setting == "picturestyle/standard" && method == "DELETE" -> {
                standard = styleDefaults
                json("""{"value":${obj(standard)}}""")
            }
            path.startsWith("/ccapi/ver100/shooting/settings/") && method == "GET" -> json(item(setting))
            path.startsWith("/ccapi/ver100/shooting/settings/") && method == "PUT" -> {
                when (setting) {
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
            path == "/ccapi/ver100/shooting/control/drivefocus" -> {
                val step = str("value")
                if (step == null || !Regex("""^(near|far)[123]$""").matches(step)) msg(400, "Invalid parameter") else {
                    focusSteps.add(step)
                    json("{}")
                }
            }
            path.startsWith("/ccapi/ver110/event/polling") -> json(events.removeFirstOrNull() ?: "{}")
            path.startsWith("/ccapi/ver100/event/polling") -> json("""{"wrongversion":true}""")
            path == "/ccapi/ver100/event/monitoring" && method == "GET" -> {
                val stream = record(RECORD_EVENT, """{"displayoff":{"value":"30"}}""".toByteArray()) +
                    record(RECORD_EVENT, """{"autopoweroff":{"value":"300"}}""".toByteArray())
                // Small chunks, so the reader has to put records together.
                MockResponse().setHeader("content-type", "application/octet-stream").setChunkedBody(Buffer().write(stream), 7)
            }
            path == "/ccapi/ver100/shooting/liveview" && method == "POST" -> json("{}")
            path == "/ccapi/ver100/shooting/liveview/flip" -> msg(503, "Live view not started")
            path.startsWith("/ccapi/ver100/shooting/liveview/flipdetail") -> {
                val kind = path.substringAfter("kind=", "both")
                val out = ByteArrayOutputStream()
                if (kind != "image") out.write(record(RECORD_INFO, liveInfo()))
                if (kind != "info") out.write(record(RECORD_JPEG, jpeg))
                binary(out.toByteArray())
            }
            path.startsWith("/ccapi/ver100/shooting/liveview/scrolldetail") && method == "GET" -> {
                val frame = record(RECORD_INFO, liveInfo()) + record(RECORD_JPEG, jpeg)
                MockResponse().setHeader("content-type", "application/octet-stream").setChunkedBody(Buffer().write(frame + frame + frame), 5)
            }
            path == "/ccapi/ver100/shooting/liveview/multipart" && method == "GET" -> {
                val part = "--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.size}\r\n\r\n".toByteArray() + jpeg + "\r\n".toByteArray()
                MockResponse().setHeader("content-type", "multipart/x-mixed-replace;boundary=boundary")
                    .setChunkedBody(Buffer().write(part + part + "--boundary--\r\n".toByteArray()), 6)
            }
            path == "/ccapi/ver100/shooting/liveview/afframeposition" -> {
                afX = (value?.get("positionx") as? JsonPrimitive)?.int ?: return msg(400, "Invalid parameter")
                afY = (value?.get("positiony") as? JsonPrimitive)?.int ?: return msg(400, "Invalid parameter")
                json("{}")
            }
            path == "/ccapi/ver100/functions/datetime" && method == "GET" -> json("""{"datetime":"$datetime","dst":$dst}""")
            path == "/ccapi/ver100/functions/datetime" && method == "PUT" -> {
                datetime = str("datetime") ?: return msg(400, "Invalid parameter")
                dst = str("dst") == "true"
                json(body)
            }
            path == "/ccapi/ver100/functions/cardformat" -> if (str("name") != "card1") msg(400, "Invalid parameter") else {
                files.clear()
                json("{}")
            }
            path.startsWith("/ccapi/ver120/contents") -> contents(request, method, path.substringBefore('?'), path.substringAfter('?', ""), str("action"), str("value"))
            path.endsWith("?kind=display") -> msg(400, "Illegal query parameter")
            path.endsWith("?kind=main") -> binary(jpeg, "image/jpeg")
            else -> msg(404, "URL not found")
        }
    }

    private fun contents(request: RecordedRequest, method: String, path: String, q: String, action: String?, actionValue: String?): MockResponse {
        val params = q.split('&').filter { it.isNotEmpty() }.associate { it.substringBefore('=') to it.substringAfter('=') }
        val file = files.firstOrNull { "$dirPath/${it.name}" == path }
        return when {
            path == "/ccapi/ver120/contents" -> json("""{"path":["/ccapi/ver120/contents/card1"]}""")
            path == "/ccapi/ver120/contents/card1" -> json("""{"path":["$dirPath"]}""")
            path == dirPath && method == "GET" -> when (params["kind"] ?: "list") {
                "number" -> json("""{"contentsnumber":${files.size},"pagenumber":${(files.size + 99) / 100}}""")
                "list" -> {
                    val page = params["page"]?.toInt() ?: 1
                    json("""{"path":${list(files.drop((page - 1) * 100).take(100).map { "$dirPath/${it.name}" })}}""")
                }
                else -> msg(400, "Illegal query parameter")
            }
            path == dirPath && method == "DELETE" -> {
                files.removeAll { !it.protect }
                if (files.isEmpty()) json("{}") else msg(409, "Partial deletion")
            }
            file == null -> msg(404, "URL not found")
            method == "GET" && params["kind"] == "info" -> json(
                """{"filesize":${file.bytes.size},"protect":"${if (file.protect) "enable" else "disable"}","archive":"disable","rotate":"0",""" +
                    """"rating":"${file.rating}","lastmodifieddate":"Wed, 04 Jul 2018 12:34:56 GMT","playtime":null}""",
            )
            method == "GET" -> {
                val range = request.getHeader("Range") ?: return binary(file.bytes, "image/jpeg")
                lastRange = range
                val m = Regex("""bytes=(\d+)-(\d*)""").matchEntire(range) ?: return msg(400, "Invalid parameter")
                val start = m.groupValues[1].toInt()
                val end = m.groupValues[2].toIntOrNull()?.coerceAtMost(file.bytes.size - 1) ?: (file.bytes.size - 1)
                if (start >= file.bytes.size || end < start) {
                    return msg(416, "Requested range not satisfiable").setHeader("content-range", "bytes */${file.bytes.size}")
                }
                binary(file.bytes.copyOfRange(start, end + 1), "image/jpeg").setResponseCode(206)
                    .setHeader("content-range", "bytes $start-$end/${file.bytes.size}")
            }
            method == "PUT" -> when (action) {
                "protect" -> json("{}").also { file.protect = actionValue == "enable" }
                "rating" -> json("{}").also { file.rating = actionValue ?: "off" }
                else -> msg(400, "Invalid parameter")
            }
            method == "DELETE" -> if (file.protect) msg(409, "File protected") else json("{}").also { files.remove(file) }
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

    private suspend fun connected(): CcapiClient = client().also { it.discover() }

    private inline fun <reified T : Exception> rejects(message: String? = null, block: () -> Unit): T {
        try {
            block()
        } catch (e: Exception) {
            if (e !is T) throw e
            if (message != null) assertEquals(message, e.message)
            return e
        }
        fail("expected ${T::class.simpleName}")
        throw IllegalStateException()
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
    fun discoveryRoutesToTheHighestVersion() = runBlocking<Unit> {
        val c = connected()
        assertEquals("/ccapi/ver110/event/polling", c.endpoint("event/polling"))
        assertEquals("/ccapi/ver110/shooting/settings/shootingmode", c.endpoint("shooting/settings/shootingmode", "put"))
        assertEquals("/ccapi/ver100/shooting/settings/av", c.endpoint("shooting/settings/av", "put"))
        assertFalse(c.has("shooting/settings/shootingmodedial", "put"))
        assertTrue("contents" in c.keys())
        // The misspelt key is offered under the right name too.
        assertEquals("Fake", c.deviceInfo()["manufacturer"])
    }

    @Test
    fun discoveryAcceptsAbsoluteUrls() = runBlocking<Unit> {
        val c = client(FakeCamera(urlStyle = true))
        c.discover()
        assertEquals("/ccapi/ver100/shooting/settings/av", c.endpoint("shooting/settings/av", "put"))
    }

    @Test
    fun settingsMergeAndEmptyOutByMode() = runBlocking<Unit> {
        val c = connected()
        val s = c.settings()
        assertEquals("av", s["shootingmode"]?.text)
        assertEquals("", s["tv"]?.text)
        assertFalse(s["tv"]!!.changeable)
        assertTrue(s["av"]!!.changeable)
        assertTrue(s["wbshift"]!!.isComposite)
        assertEquals(mapOf("ba" to 0, "mg" to 0), s["wbshift"]!!.fields)
        assertFalse(s["av"]!!.isComposite)
    }

    @Test
    fun invalidValuesComeBackWithTheOptions() = runBlocking<Unit> {
        val c = connected()
        rejects<SettingException>("av = \"f1.4\" is not accepted. Options: f2.8, f4.0, f5.6, f8.0.") { c.set("av", "f1.4") }
        rejects<SettingException>("tv can't be changed in the current shooting mode.") { c.set("tv", "1/1000") }
        rejects<SettingException>("colortemperature must be a whole number from 2500 to 10000 in steps of 100.") { c.set("colortemperature", 3150) }
        rejects<SettingException>("av takes a single value, not an object.") { c.set("av", mapOf("value" to "f2.8")) }
        // Nothing invalid was sent to the camera.
        assertTrue(camera.requests.none { it.startsWith("PUT") })
    }

    @Test
    fun compositeSettingsAreValidatedBeforeSending() = runBlocking<Unit> {
        val c = connected()
        rejects<SettingException>("wbshift.ba must be a whole number from -9 to 9 in steps of 1.") { c.setWbShift(12, 0) }
        rejects<SettingException>("wbshift needs every field; mg is missing.") { c.set("wbshift", mapOf("ba" to 1)) }
        rejects<SettingException>("wbshift takes an object with ba, mg.") { c.set("wbshift", "1,1") }
        rejects<SettingException>("stillimagequality.raw = \"huge\" is not accepted. Options: none, raw, craw.") { c.setStillImageQuality(raw = "huge") }
        rejects<SettingException>("picturestyle/standard.sharpness_strength must be a whole number from 0 to 7 in steps of 1.") {
            c.setPictureStyleDetail("standard", mapOf("sharpness_strength" to 9))
        }
        assertTrue(camera.requests.none { it.startsWith("PUT") })

        c.setWbShift(-3, 4)
        assertEquals("""{"value":{"ba":-3,"mg":4}}""", camera.putBodies.last())
        assertEquals(mapOf("ba" to -3, "mg" to 4), c.compositeSetting("wbshift").fields)

        // Partial changes keep the other fields.
        c.setStillImageQuality(raw = "craw")
        assertEquals(mapOf("raw" to "craw", "jpeg" to "large"), camera.quality)
        c.setPictureStyleDetail("standard", mapOf("contrast" to 2))
        assertEquals(2, c.pictureStyleDetail("standard").fields["contrast"])
        assertEquals(4, camera.standard["sharpness_strength"])
        // The bulk-list name works too; DELETE brings back the defaults.
        val reset = c.resetSetting("picturestyle_standard")
        assertEquals(0, reset.jsonObject["contrast"]!!.jsonPrimitive.int)
        assertEquals(0, camera.standard["contrast"])

        // The read-only base of a user style is left out of the change.
        c.setPictureStyleDetail("userdef1", mapOf("contrast" to -1))
        assertEquals("""{"value":{"contrast":-1}}""", camera.putBodies.last())
    }

    @Test
    fun modeChangeTurnsOnIgnoreDialAndRetries() = runBlocking<Unit> {
        val c = connected()
        c.setMode("tv")
        assertEquals("tv", camera.mode)
        assertTrue(camera.ignoreDial)
        c.set("tv", "1/1000")
        assertEquals("1/1000", camera.tv)
        val puts = camera.requests.filter { it.startsWith("PUT /ccapi/ver110/shooting/settings/shootingmode") }
        assertEquals(2, puts.size)
    }

    @Test
    fun shootThenFindTheFileInPollingAndFallBackToMain() = runBlocking<Unit> {
        val c = connected()
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
    fun pollingUsesEachVersionsOwnQuery() = runBlocking<Unit> {
        val c = connected()
        c.poll()
        c.poll("long")
        assertEquals(true, c.poll("immediately", "ver100")["wrongversion"]?.jsonPrimitive?.content?.toBoolean())
        c.poll("short", "ver100")
        val polls = camera.requests.filter { "event/polling" in it }
        assertEquals(
            listOf(
                "GET /ccapi/ver110/event/polling?timeout=immediately",
                "GET /ccapi/ver110/event/polling?timeout=long",
                "GET /ccapi/ver100/event/polling?continue=off",
                "GET /ccapi/ver100/event/polling?continue=on",
            ),
            polls,
        )
        rejects<CcapiException>("This camera has no event polling") { c.poll("immediately", "ver130") }
    }

    @Test
    fun monitoringIsReadAsItArrives() = runBlocking<Unit> {
        val c = connected()
        val streamed = c.monitorEvents().take(2).toList()
        assertEquals(listOf("displayoff", "autopoweroff"), streamed.map { it.keys.single() })
        val buffered = c.monitor()
        assertEquals("300", buffered[1]["autopoweroff"]!!.jsonObject["value"]!!.jsonPrimitive.content)
    }

    @Test
    fun flipDetailParsesWithHistogramAndAfFrames() = runBlocking<Unit> {
        val c = connected()
        val d = c.liveDetail("both")
        assertArrayEquals(camera.jpeg, d.image)
        val info = d.info!!
        val hist = info.histogram!!
        assertEquals(4, hist.size)
        assertTrue(hist.all { it.size == 256 })
        assertEquals(6000, hist[0].sum())
        assertEquals(6000, hist[0][128])
        assertEquals(6000 to 4000, info.sensorSize)
        assertEquals(1, info.magnification)
        assertEquals(1, info.afFrames.single().status)
        assertTrue(camera.requests.contains("GET /ccapi/ver100/shooting/liveview/flipdetail?kind=both"))

        val imageOnly = c.liveDetail("image")
        assertNull(imageOnly.info)
        assertArrayEquals(camera.jpeg, imageOnly.image)
        val infoOnly = c.liveDetail("info")
        assertNull(infoOnly.image)
        assertEquals(4, infoOnly.info!!.histogram!!.size)
    }

    @Test
    fun liveStreamsAreReadFrameByFrame() = runBlocking<Unit> {
        val c = connected()
        val detail = c.liveFrames("scrolldetail", "both").toList()
        assertEquals(3, detail.size)
        assertTrue(detail.all { it.image != null && it.info?.histogram?.size == 4 })
        assertEquals(3, c.liveStream("scrolldetail", "both").size)
        assertTrue(camera.requests.contains("GET /ccapi/ver100/shooting/liveview/scrolldetail?kind=both"))
        val parts = c.liveFrames("multipart").toList()
        assertEquals(2, parts.size)
        assertArrayEquals(camera.jpeg, parts[0].image)
        assertEquals(2, c.liveStream("multipart").size)
    }

    @Test
    fun afFramePositionAndFocusDrive() = runBlocking<Unit> {
        val c = connected()
        c.setAfFramePosition(100, 740)
        assertEquals(100 to 740, camera.afX to camera.afY)
        val frame = c.liveDetail("info").info!!.afFrames.single()
        assertEquals(100 to 740, frame.x to frame.y)
        c.driveFocus("near3")
        c.driveFocus("far1")
        assertEquals(listOf("near3", "far1"), camera.focusSteps)
        val e = rejects<CcapiException>("Invalid parameter") { c.driveFocus("near9") }
        assertEquals(400, e.status)
    }

    @Test
    fun functionsSetTheClockAndFormatTheCard() = runBlocking<Unit> {
        val c = connected()
        c.setDatetime(Instant.parse("2024-06-01T12:00:00Z"), false, 120)
        assertEquals("Sat, 01 Jun 2024 14:00:00 +0200", camera.datetime)
        val clock = c.datetime()
        assertEquals("Sat, 01 Jun 2024 14:00:00 +0200", clock.datetime)
        assertFalse(clock.dst)
        c.setDatetime(Instant.parse("2024-12-31T23:59:59Z"), true, -330)
        assertTrue(c.datetime().dst)
        assertEquals("Tue, 31 Dec 2024 18:29:59 -0530", camera.datetime)

        assertEquals(150, c.contentsCount(camera.dirPath).contentsNumber)
        c.formatCard("card1")
        assertTrue(camera.files.isEmpty())
        assertEquals(emptyList<String>(), c.files(camera.dirPath))
    }

    @Test
    fun contentsPageInfoRangeProtectAndDelete() = runBlocking<Unit> {
        val c = connected()
        val storage = c.storages().single()
        assertEquals("/ccapi/ver120/contents/card1", storage)
        val dir = c.directories(storage).single()
        assertEquals(ContentsCount(150, 2), c.contentsCount(dir))
        assertEquals(100, c.files(dir).size)
        assertEquals(50, c.files(dir, page = 2).size)
        assertTrue(camera.requests.contains("GET $dir?page=2"))
        val all = c.allFiles(dir)
        assertEquals(150, all.size)
        assertEquals("$dir/IMG_0150.JPG", all.last())

        val path = all[0]
        val info = c.fileInfo("http://192.168.1.2:8080$path") // absolute URLs are reduced to paths
        assertEquals(1000L, info.fileSize)
        assertEquals("disable", info.protect)
        assertNull(info.playTime)

        val part = c.downloadRange(path, 2, 9)
        assertEquals("bytes=2-9", camera.lastRange)
        assertEquals(listOf(2L, 9L, 1000L), listOf(part.start, part.end, part.total))
        assertArrayEquals(camera.files[0].bytes.copyOfRange(2, 10), part.bytes)
        val tail = c.downloadRange(path, 990)
        assertEquals("bytes=990-", camera.lastRange)
        assertEquals(10, tail.bytes.size)
        assertEquals(999L, tail.end)
        assertEquals(416, rejects<CcapiException> { c.downloadRange(path, 1010) }.status)

        c.protectFile(path, true)
        c.rateFile(path, 4)
        val after = c.fileInfo(path)
        assertEquals("enable", after.protect)
        assertEquals("4", after.rating)
        assertEquals(409, rejects<CcapiException>("File protected") { c.deleteFile(path) }.status)
        c.deleteFile(all[1])
        assertEquals(149, c.contentsCount(dir).contentsNumber)
        rejects<CcapiException>("Partial deletion") { c.deleteDirectory(dir) }
        assertEquals(listOf(path), c.files(dir))
    }

    @Test
    fun liveViewIsStartedWhenNeededAndErrorsKeepTheirMessage() = runBlocking<Unit> {
        val c = connected()
        val e = rejects<CcapiException>("Live view not started") { c.liveFrame() }
        assertEquals(503, e.status)
        assertTrue(camera.requests.any { it.startsWith("POST /ccapi/ver100/shooting/liveview") })
    }

    @Test
    fun digestAuthAnswersTheChallenge() = runBlocking<Unit> {
        camera.authRequired = "user" to "secret"
        val c = client(user = "user", pass = "secret")
        c.discover()
        assertEquals("Fake EOS", c.deviceInfo()["productname"])
    }

    @Test
    fun wrongPasswordFails() = runBlocking<Unit> {
        camera.authRequired = "user" to "secret"
        val c = client(user = "user", pass = "nope")
        assertEquals(401, rejects<CcapiException> { c.discover() }.status)
    }

    // ---------------------------------------------------------------- formats

    @Test
    fun recordsReadEitherByteOrderAndGroupIntoFrames() {
        val info = """{"liveviewdata":{"histogram":[[1,2],[3],[4],[5]]}}""".toByteArray()
        // A JPEG holding FF 00 / FF FF pairs: records are split by length, not by markers.
        val tricky = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0x00, 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xD9.toByte())
        val bytes = record(RECORD_INFO, info, bigEndian = false) + record(RECORD_JPEG, tricky) + record(RECORD_JPEG, tricky, bigEndian = false)
        val records = parseRecords(bytes)
        assertEquals(listOf(RECORD_INFO, RECORD_JPEG, RECORD_JPEG), records.map { it.type })
        assertArrayEquals(tricky, records[2].data)
        val frames = detailFrames(records)
        assertEquals(2, frames.size)
        assertEquals(listOf(1, 2), frames[0].info!!.histogram!![0].toList())
        assertNull(frames[1].info)
        try {
            parseRecords(byteArrayOf(0x12, 0x34, 0, 0, 0, 0, 0, 0, 0))
            fail("expected a format error")
        } catch (e: java.io.IOException) {
            assertEquals("Bad live view record at byte 0", e.message)
        }
    }

    @Test
    fun multipartJpegRunsAndJsonSequences() {
        val j = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 0xFF.toByte(), 0xD9.toByte())
        val lf = "--boundary\nContent-Type: image/jpeg\nContent-Length: 6\n\n".toByteArray() + j + "\n--boundary--\n".toByteArray()
        assertEquals(1, parseMultipart(lf).size)
        assertArrayEquals(j, parseMultipart(lf)[0])
        assertEquals(2, splitJpegs(j + j).size)
        assertArrayEquals(j, splitJpegs(j + j)[1])
        val seq = parseJsonSequence("""{"path":["a{b}"]}{"path":["c\"}"]}""")
        assertEquals(2, seq.size)
        assertEquals("c\"}", seq[1].jsonObject["path"]!!.jsonArray[0].jsonPrimitive.content)
        assertEquals("Tue, 01 Jan 2019 01:23:45 +0900", formatCameraDate(Instant.parse("2018-12-31T16:23:45Z"), 540))
    }
}
