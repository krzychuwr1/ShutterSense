package dev.shuttersense.app.ccapi

// CCAPI setting values: parsing and formatting for people. A port of
// shared/settings.ts; keep the two in step.
//
// Formats used by the camera:
//   tv        "1/125", 0"5 (0.5 s), 1"3 (1.3 s), 30" (30 s)
//   av        "f2.8", "f5.6", "f11", "f22"
//   iso       "auto", "100", "6400"
//   exposure  "+0.0", "+1_1/3", "-0_2/3", "+2.0"
object CameraValues {
    private val TV_FRACTION = Regex("""^1/(\d+(?:\.\d+)?)$""")
    private val TV_SECONDS = Regex("""^(\d+)"(\d*)$""")
    private val AV = Regex("""^f(\d+(?:\.\d+)?)$""", RegexOption.IGNORE_CASE)
    private val ISO = Regex("""^(\d+)$""")
    private val EV_DECIMAL = Regex("""^([+-]?)(\d+)\.(\d+)$""")
    private val EV_THIRDS = Regex("""^([+-]?)(\d+)_(\d)/(\d)$""")
    private val EV_PRETTY = Regex("""^([+-]?)(\d+)(?:\.0|_(\d/\d))$""")

    /** Shutter speed in seconds, or null if not a shutter speed. */
    fun tvSeconds(v: String): Double? {
        val s = v.trim()
        TV_FRACTION.matchEntire(s)?.let { return 1 / it.groupValues[1].toDouble() }
        TV_SECONDS.matchEntire(s)?.let {
            val frac = it.groupValues[2]
            return it.groupValues[1].toDouble() + (if (frac.isNotEmpty()) "0.$frac".toDouble() else 0.0)
        }
        return null
    }

    /** f-number, or null. */
    fun avNumber(v: String): Double? = AV.matchEntire(v.trim())?.groupValues?.get(1)?.toDouble()

    /** ISO number, or null for "auto" and anything else. */
    fun isoNumber(v: String): Int? = ISO.matchEntire(v.trim())?.groupValues?.get(1)?.toIntOrNull()

    /** Exposure compensation in stops, or null. */
    fun evStops(v: String): Double? {
        val s = v.trim()
        EV_DECIMAL.matchEntire(s)?.let {
            val sign = if (it.groupValues[1] == "-") -1 else 1
            return sign * "${it.groupValues[2]}.${it.groupValues[3]}".toDouble()
        }
        EV_THIRDS.matchEntire(s)?.let {
            val sign = if (it.groupValues[1] == "-") -1 else 1
            return sign * (it.groupValues[2].toDouble() + it.groupValues[3].toDouble() / it.groupValues[4].toDouble())
        }
        return null
    }

    private val FRACTIONS = mapOf("1/3" to "⅓", "2/3" to "⅔", "1/2" to "½")
    private val MODE_NAMES = mapOf("m" to "M", "av" to "Av", "tv" to "Tv", "p" to "P", "fv" to "Fv", "a+" to "A+", "auto" to "Auto", "bulb" to "Bulb")

    /** Formats a number the way JavaScript prints it: 8.0 -> "8", 0.5 -> "0.5". */
    fun num(d: Double): String = if (d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 1e15) d.toLong().toString() else d.toString()

    /** A setting value as a photographer would write it: "f/2.8", "1/1000 s", "0.5 s", "+1⅔ EV", "ISO 800". */
    fun prettyValue(setting: String, v: Any?): String {
        if (v == null) return "–"
        val s = if (v is Double) num(v) else v.toString()
        if (s.isEmpty()) return "–"
        return when (setting) {
            "av" -> avNumber(s)?.let { "f/${num(it)}" } ?: s
            "tv" -> if (s.startsWith("1/")) "$s s" else tvSeconds(s)?.let { "${num(it)} s" } ?: s
            "iso" -> if (s == "auto") "ISO auto" else "ISO $s"
            "exposure" -> {
                val m = EV_PRETTY.matchEntire(s) ?: return s
                val sign = m.groupValues[1]
                val whole0 = m.groupValues[2]
                val third = m.groups[3]?.value
                val whole = if (whole0 == "0" && third != null) "" else whole0
                val frac = if (third != null) FRACTIONS[third] ?: "_$third" else ""
                if (whole == "0" && frac.isEmpty()) "±0 EV" else "${sign.ifEmpty { "+" }}$whole$frac EV"
            }
            "colortemperature" -> "$s K"
            "shootingmode", "shootingmodedial" -> MODE_NAMES[s] ?: s
            else -> s
        }
    }

    /** Short labels for the settings diff: "Shutter 1/60 s → 1/1000 s". */
    val SETTING_LABELS = mapOf(
        "shootingmode" to "Mode",
        "shootingmodedial" to "Mode",
        "av" to "Aperture",
        "tv" to "Shutter",
        "iso" to "ISO",
        "exposure" to "Exp. comp.",
        "wb" to "WB",
        "colortemperature" to "Colour temp.",
        "metering" to "Metering",
        "afoperation" to "AF",
        "afmethod" to "AF area",
        "drive" to "Drive",
        "picturestyle" to "Picture style",
        "flash" to "Flash",
        "shuttermode" to "Shutter type",
        "trackingsetting" to "Tracking",
        "stillimageaspectratio" to "Aspect ratio",
        "wbshift" to "WB shift",
        "antiflickershoot" to "Anti-flicker",
        "hfantiflickershoot" to "HF anti-flicker",
        "hfflickertv" to "HF flicker shutter",
        "contrast" to "Contrast",
        "saturation" to "Saturation",
        "sharpness_strength" to "Sharpness",
        "colortone" to "Colour tone",
    )

    fun diffLine(setting: String, from: Any?, to: Any?): String {
        val label = SETTING_LABELS[setting] ?: setting
        fun p(v: Any?): String = when {
            // Composite values such as the WB shift: "BA +2 MG 0".
            v is Map<*, *> -> v.entries.joinToString(" ") { (k, n) -> "${k.toString().uppercase()} ${if (n is Number && n.toDouble() > 0) "+" else ""}$n" }
            setting == "iso" -> v?.let { if (it is Double) num(it) else it.toString() } ?: "–"
            else -> prettyValue(setting, v)
        }
        return "$label ${p(from)} → ${p(to)}"
    }
}
