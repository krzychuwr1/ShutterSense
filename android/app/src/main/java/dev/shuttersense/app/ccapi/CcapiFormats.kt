package dev.shuttersense.app.ccapi

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.time.Instant
import java.time.ZoneOffset

// The binary and text formats the camera answers with, readable both from a
// whole body and from a stream as it arrives: framed records (live view
// detail and event monitoring), the multipart live view, back-to-back JPEGs
// (scroll), and runs of JSON objects (chunked contents lists). Plus the
// camera's date format. Mirrors the helpers at the end of ccapi/client.ts.

const val RECORD_JPEG = 0x00
const val RECORD_INFO = 0x01
const val RECORD_EVENT = 0x02

/** A framed record: FF 00 <type> <size:4> <data> FF FF. Types: 0 JPEG, 1 info JSON, 2 event JSON. */
class FramedRecord(val type: Int, val data: ByteArray)

/** Largest record we try to read (a live view JPEG is far smaller). */
private const val MAX_RECORD = 64L * 1024 * 1024

private fun InputStream.readUpTo(buf: ByteArray): Int {
    var n = 0
    while (n < buf.size) {
        val r = read(buf, n, buf.size - n)
        if (r < 0) break
        n += r
    }
    return n
}

private fun InputStream.buffered(): InputStream = if (markSupported()) this else BufferedInputStream(this)

/**
 * Reads framed records one at a time. The size's byte order isn't known:
 * big-endian is tried first, little-endian when that
 * doesn't land on the end marker.
 */
class RecordReader(input: InputStream) {
    private val input = input.buffered()
    private var offset = 0L

    /** The next record, or null at the end of the stream. */
    fun next(): FramedRecord? {
        val head = ByteArray(7)
        if (input.readUpTo(head) < 7) return null
        if (head[0] != 0xFF.toByte() || head[1] != 0x00.toByte()) throw IOException("Bad live view record at byte $offset")
        val type = head[2].toInt() and 0xFF
        val be = u32(head, 3, bigEndian = true)
        val le = u32(head, 3, bigEndian = false)
        val data = attempt(be) ?: (if (le != be) attempt(le) else null)
            ?: throw IOException("Bad live view record size at byte $offset")
        offset += data.size + 9
        return FramedRecord(type, data)
    }

    /** Reads [size] bytes and the end marker; rewinds and returns null when the marker isn't there. */
    private fun attempt(size: Long): ByteArray? {
        if (size > MAX_RECORD) return null
        input.mark(size.toInt() + 2)
        val data = ByteArray(size.toInt())
        val end = ByteArray(2)
        if (input.readUpTo(data) == data.size && input.readUpTo(end) == 2 && end[0] == 0xFF.toByte() && end[1] == 0xFF.toByte()) return data
        input.reset()
        return null
    }

    private fun u32(b: ByteArray, at: Int, bigEndian: Boolean): Long {
        var v = 0L
        for (i in 0 until 4) {
            val byte = (b[at + if (bigEndian) i else 3 - i].toLong() and 0xFF)
            v = (v shl 8) or byte
        }
        return v
    }
}

fun parseRecords(bytes: ByteArray): List<FramedRecord> {
    val r = RecordReader(ByteArrayInputStream(bytes))
    return generateSequence { r.next() }.toList()
}

/** Groups records into frames: an info record belongs with the image that follows it. */
fun detailFrames(records: List<FramedRecord>): List<LiveDetail> {
    val out = mutableListOf<LiveDetail>()
    var image: ByteArray? = null
    var info: LiveViewInfo? = null
    for (r in records) {
        if (r.type == RECORD_INFO) {
            if (info != null || image != null) out.add(LiveDetail(image, info))
            image = null
            info = LiveViewInfo(parseObject(r.data))
        } else if (r.type == RECORD_JPEG) {
            if (image != null) {
                out.add(LiveDetail(image, info))
                info = null
            }
            image = r.data
        }
    }
    if (info != null || image != null) out.add(LiveDetail(image, info))
    return out
}

internal fun parseObject(bytes: ByteArray): JsonObject =
    CcapiClient.json.parseToJsonElement(bytes.decodeToString()) as? JsonObject ?: JsonObject(emptyMap())

/** The JPEG parts of a multipart/x-mixed-replace stream (LF or CRLF line ends). */
class MultipartReader(input: InputStream, private val boundary: String = "boundary") {
    private val input = input.buffered()

    /** The next part's body, or null at the closing boundary or the end of the stream. */
    fun next(): ByteArray? {
        while (true) {
            val line = readLine() ?: return null
            if (line.startsWith("--$boundary--")) return null
            if (line.startsWith("--$boundary")) break
        }
        var length = -1
        while (true) {
            val line = readLine() ?: return null
            if (line.isEmpty()) break
            Regex("""^content-length:\s*(\d+)""", RegexOption.IGNORE_CASE).find(line)?.let { length = it.groupValues[1].toInt() }
        }
        if (length < 0) return null
        val data = ByteArray(length)
        return if (input.readUpTo(data) == length) data else null
    }

    private fun readLine(): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = input.read()
            if (c < 0) return if (b.size() == 0) null else b.toString(Charsets.ISO_8859_1.name())
            if (c == '\n'.code) break
            b.write(c)
        }
        return b.toString(Charsets.ISO_8859_1.name()).removeSuffix("\r")
    }
}

/** The JPEGs of a multipart/x-mixed-replace body (boundary "boundary", LF or CRLF line ends). */
fun parseMultipart(bytes: ByteArray, boundary: String = "boundary"): List<ByteArray> {
    val r = MultipartReader(ByteArrayInputStream(bytes), boundary)
    return generateSequence { r.next() }.toList()
}

/** The boundary named in a multipart content type, or "boundary". */
internal fun multipartBoundary(contentType: String): String =
    Regex("""boundary="?([^";\s]+)"?""", RegexOption.IGNORE_CASE).find(contentType)?.groupValues?.get(1) ?: "boundary"

/** Back-to-back JPEGs (a de-chunked scroll stream), split where an end marker meets the next start marker. */
class JpegSplitter(input: InputStream) {
    private val input = input.buffered()
    private var emitted = false

    /** The next JPEG, or null at the end of the stream. */
    fun next(): ByteArray? {
        val buf = ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val c = input.read()
            if (c < 0) {
                // Without any end marker the whole body is taken as one picture.
                if (!emitted && buf.size() > 0) {
                    emitted = true
                    return buf.toByteArray()
                }
                return null
            }
            buf.write(c)
            if (prev == 0xFF && c == 0xD9 && buf.size() >= 4) {
                input.mark(2)
                val a = input.read()
                val b = input.read()
                input.reset()
                if (a < 0 || (a == 0xFF && b == 0xD8)) {
                    emitted = true
                    return buf.toByteArray()
                }
            }
            prev = c
        }
    }
}

fun splitJpegs(bytes: ByteArray): List<ByteArray> {
    val r = JpegSplitter(ByteArrayInputStream(bytes))
    return generateSequence { r.next() }.toList()
}

/** Concatenated JSON objects ({…}{…}), as a de-chunked contents list arrives. */
fun parseJsonSequence(text: String): List<JsonElement> {
    val out = mutableListOf<JsonElement>()
    var depth = 0
    var start = -1
    var inString = false
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (inString) {
            if (c == '\\') i++ else if (c == '"') inString = false
        } else if (c == '"') {
            inString = true
        } else if (c == '{') {
            if (depth++ == 0) start = i
        } else if (c == '}' && --depth == 0) {
            out.add(CcapiClient.json.parseToJsonElement(text.substring(start, i + 1)))
        }
        i++
    }
    return out
}

private val DAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** A camera date: "Tue, 01 Jan 2019 01:23:45 +0900" for [time] shown in a zone [offsetMinutes] east of UTC. */
fun formatCameraDate(time: Instant, offsetMinutes: Int): String {
    val t = time.atOffset(ZoneOffset.ofTotalSeconds(offsetMinutes * 60))
    fun p(n: Int) = n.toString().padStart(2, '0')
    val z = Math.abs(offsetMinutes)
    return "${DAYS[t.dayOfWeek.value - 1]}, ${p(t.dayOfMonth)} ${MONTHS[t.monthValue - 1]} ${t.year} " +
        "${p(t.hour)}:${p(t.minute)}:${p(t.second)} ${if (offsetMinutes < 0) "-" else "+"}${p(z / 60)}${p(z % 60)}"
}
