package dev.shuttersense.app.ccapi

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// What the camera answers with, as Kotlin types: setting abilities (lists,
// ranges and per-field composites), device status, contents and live view
// incidental information. Mirrors the types in ccapi/client.ts.

sealed class Ability {
    data class Options(val values: List<String>) : Ability()
    data class Range(val min: Int?, val max: Int?, val step: Int?) : Ability()

    /** Per-field abilities of a value that is an object (wbshift, stillimagequality, picture style detail, powerzoom). */
    data class Composite(val fields: Map<String, Ability>) : Ability()

    val changeable: Boolean
        get() = when (this) {
            is Options -> values.isNotEmpty()
            is Range -> min != null && max != null
            is Composite -> fields.values.any { it.changeable }
        }

    fun toJson(): JsonElement = when (this) {
        is Options -> JsonArray(values.map { JsonPrimitive(it) })
        is Range -> buildJsonObject {
            put("min", min)
            put("max", max)
            put("step", step)
        }
        is Composite -> JsonObject(fields.mapValues { it.value.toJson() })
    }

    companion object {
        /** A list, a {min, max, step} range, or an object of either per field. */
        fun parse(ab: JsonElement?): Ability = when {
            ab is JsonArray -> Options(ab.mapNotNull { (it as? JsonPrimitive)?.contentOrNull })
            ab is JsonObject && "min" in ab -> Range(
                (ab["min"] as? JsonPrimitive)?.intOrNull,
                (ab["max"] as? JsonPrimitive)?.intOrNull,
                (ab["step"] as? JsonPrimitive)?.intOrNull,
            )
            ab is JsonObject -> Composite(ab.mapValues { parse(it.value) })
            else -> Options(emptyList())
        }
    }
}

data class SettingItem(val value: JsonElement, val ability: Ability) {
    /** The value as a string ("" when the mode doesn't use it), or null. */
    val text: String? get() = (value as? JsonPrimitive)?.contentOrNull

    val changeable: Boolean get() = ability.changeable

    /** Whether the value is an object with per-field abilities. */
    val isComposite: Boolean get() = ability is Ability.Composite

    /** The fields of a composite value (empty for single values). */
    val fields: Map<String, Any?> get() = (value as? JsonObject)?.mapValues { plainValue(it.value) } ?: emptyMap()

    companion object {
        fun parse(e: JsonElement?): SettingItem? {
            val o = e as? JsonObject ?: return null
            return SettingItem(o["value"] ?: JsonNull, Ability.parse(o["ability"]))
        }
    }
}

typealias Settings = Map<String, SettingItem>

/** Validates a value against an ability, with messages that list what would work. */
fun checkValue(name: String, value: Any, item: SettingItem) {
    val ab = item.ability
    if (ab is Ability.Composite) {
        val fields = fieldsOf(value)
            ?: throw SettingException(name, "$name takes an object with ${ab.fields.keys.joinToString(", ")}.")
        for ((field, fab) in ab.fields) {
            // The base of a user-defined picture style is read-only here.
            if (fab is Ability.Options && fab.values.isEmpty() && field == "basepicturestyle") continue
            if (field !in fields) throw SettingException(name, "$name needs every field; $field is missing.")
            checkValue("$name.$field", fields[field] ?: JsonNull, SettingItem(JsonNull, fab))
        }
        return
    }
    if (fieldsOf(value) != null) throw SettingException(name, "$name takes a single value, not an object.")
    when (ab) {
        is Ability.Options -> {
            if (ab.values.isEmpty()) throw SettingException(name, "$name can't be changed in the current shooting mode.")
            // Numbers are compared by their text, as option lists are kept as strings.
            val accepted = when (value) {
                is String -> value in ab.values
                is Number -> wholeNumber(value)?.toString() in ab.values || value.toString() in ab.values
                else -> false
            }
            if (!accepted) {
                val shown = if (ab.values.size > 40) ab.values.take(40).joinToString(", ") + ", …" else ab.values.joinToString(", ")
                throw SettingException(name, "$name = ${CcapiClient.quote(value)} is not accepted. Options: $shown.")
            }
        }
        is Ability.Range -> {
            val min = ab.min
            val max = ab.max
            if (min == null || max == null) throw SettingException(name, "$name can't be changed in the current shooting mode.")
            val step = ab.step?.takeIf { it != 0 } ?: 1
            val n = (value as? Number)?.let(::wholeNumber)
            if (n == null || n < min || n > max || (n - min) % step != 0L) {
                throw SettingException(name, "$name must be a whole number from $min to $max in steps of $step.")
            }
        }
        is Ability.Composite -> Unit // handled above
    }
}

/** A whole number as a Long (3.0 counts), or null. */
internal fun wholeNumber(n: Number): Long? = when (n) {
    is Int, is Long, is Short, is Byte -> n.toLong()
    else -> n.toDouble().takeIf { it % 1.0 == 0.0 && !it.isInfinite() }?.toLong()
}

/** The fields of an object value (a Map or a JsonObject), or null for a single value. */
internal fun fieldsOf(value: Any): Map<String, Any?>? = when (value) {
    is JsonObject -> value.mapValues { plainValue(it.value) }
    is Map<*, *> -> value.entries.associate { (k, v) -> k.toString() to (if (v is JsonElement) plainValue(v) else v) }
    else -> null
}

/** A JSON value as String / Int / Long / Double / Boolean / null (objects and arrays stay JSON). */
internal fun plainValue(e: JsonElement): Any? = when {
    e is JsonNull -> null
    e is JsonPrimitive && e.isString -> e.content
    e is JsonPrimitive -> e.booleanOrNull ?: e.intOrNull ?: e.longOrNull ?: e.doubleOrNull ?: e.content
    else -> e
}

/** A value as JSON for a request body; whole numbers are sent without a fraction. */
internal fun toJson(value: Any?): JsonElement = when (value) {
    null -> JsonNull
    is JsonElement -> value
    is Boolean -> JsonPrimitive(value)
    is Number -> wholeNumber(value)?.let { if (it in Int.MIN_VALUE..Int.MAX_VALUE) JsonPrimitive(it.toInt()) else JsonPrimitive(it) } ?: JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to toJson(v) })
    is List<*> -> JsonArray(value.map(::toJson))
    else -> JsonPrimitive(value.toString())
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

// ------------------------------------------------------------------ device status

data class StorageInfo(
    val name: String,
    /** Contents path of the storage (absolute URLs from older cameras are reduced to paths). */
    val path: String,
    /** "readwrite" or "readonly". */
    val accessCapability: String,
    val maxSize: Long,
    val spaceSize: Long,
    val contentsNumber: Int,
)

data class BatteryInfo(
    val position: String,
    val name: String,
    val kind: String,
    /** Percentage "0".."100" (batterylist), or a level word (battery): full, high, half, quarter, low, … */
    val level: String,
    val quality: String,
)

data class LensInfo(val mount: Boolean, val name: String)

/** A storage or folder: its name and contents path. */
data class NamedPath(val name: String, val path: String)

/** The camera clock: an RFC 1123 date with a numeric zone, and whether daylight saving is on. */
data class CameraClock(val datetime: String, val dst: Boolean)

/** Remaining shots (still mode) or seconds (movie mode); the other is null. */
data class Recordable(val shots: Int?, val remainingTime: Int?)

// ------------------------------------------------------------------ contents

data class ContentsCount(val contentsNumber: Int, val pageNumber: Int)

data class FileInfo(
    val fileSize: Long,
    /** "enable" or "disable". */
    val protect: String,
    val archive: String,
    /** "0", "90", "180" or "270". */
    val rotate: String,
    /** "off" or "1".."5". */
    val rating: String,
    val lastModified: String,
    /** Seconds, for movies. */
    val playTime: Int?,
    /** "pq" or "off" (ver110+). */
    val hdr: String?,
) {
    companion object {
        fun parse(o: JsonObject) = FileInfo(
            o.long("filesize") ?: 0, o.str("protect") ?: "", o.str("archive") ?: "", o.str("rotate") ?: "",
            o.str("rating") ?: "", o.str("lastmodifieddate") ?: "", o.int("playtime"), o.str("hdr"),
        )
    }
}

/** Part of a file: [start]..[end] inclusive, of [total] bytes (null when the camera didn't say). */
class FilePart(val bytes: ByteArray, val start: Long, val end: Long, val total: Long?)

// ------------------------------------------------------------------ live view

/** A rectangle in still-image Large pixels. */
data class LiveRect(val x: Int, val y: Int, val width: Int, val height: Int)

/** status: 0 standby, 1 in focus, 2 focus failed, …; select: 0 not selected, 1 selected, 2 not selectable. */
data class AfFrame(val status: Int, val select: Int, val x: Int, val y: Int, val width: Int, val height: Int)

/** Electronic level: posture code, roll and pitch in 1/100 degree. */
data class AngleInfo(val posture: Int, val rolling: Int, val pitching: Int)

/** Live view incidental information (coordinates in still-image Large pixels). [raw] keeps everything. */
class LiveViewInfo(val raw: JsonObject) {
    private val data = raw.obj("liveviewdata")

    /** Y, R, G, B; 256 bins each. */
    val histogram: List<IntArray>? = (data?.get("histogram") as? JsonArray)?.map { ch ->
        (ch as? JsonArray)?.map { (it as? JsonPrimitive)?.intOrNull ?: 0 }?.toIntArray() ?: IntArray(0)
    }

    val afFrames: List<AfFrame> = (data?.get("afframe") as? JsonArray)?.mapNotNull { e ->
        val f = e as? JsonObject ?: return@mapNotNull null
        AfFrame(f.int("status") ?: 0, f.int("select") ?: 0, f.int("x") ?: 0, f.int("y") ?: 0, f.int("width") ?: 0, f.int("height") ?: 0)
    } ?: emptyList()

    /** The part of the sensor the live view picture shows. */
    val image: LiveRect? = rect("image")

    /** The full sensor size (still-image Large), as width x height. */
    val sensorSize: Pair<Int, Int>? = data?.obj("image")?.let { o -> o.int("sizex")?.let { w -> o.int("sizey")?.let { h -> w to h } } }

    val visible: LiveRect? = rect("visible")
    val zoom: LiveRect? = rect("zoom")
    val magnification: Int? = data?.obj("zoom")?.int("magnification")
    val diorama: LiveRect? = rect("diorama")

    /** Capture time: seconds and milliseconds. */
    val systemTime: Pair<Long, Int>? = data?.obj("systemtime")?.let { o -> o.long("sec")?.let { it to (o.int("subsec") ?: 0) } }

    val angle: AngleInfo? = raw.obj("angleinformation")?.let { AngleInfo(it.int("cameraposture") ?: 0, it.int("rolling") ?: 0, it.int("pitching") ?: 0) }

    private fun rect(key: String): LiveRect? {
        val o = data?.obj(key) ?: return null
        return LiveRect(o.int("positionx") ?: 0, o.int("positiony") ?: 0, o.int("positionwidth") ?: 0, o.int("positionheight") ?: 0)
    }
}

/** A live view frame and/or its incidental information. */
class LiveDetail(val image: ByteArray? = null, val info: LiveViewInfo? = null)
