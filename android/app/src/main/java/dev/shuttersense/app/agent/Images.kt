package dev.shuttersense.app.agent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

data class ImageStats(
    /** Mean luminance, 0-255. */
    val mean: Int,
    /** Mean luminance of the centre ninth of the frame. */
    val center: Int,
    /** Percent of pixels at or near white / black. */
    val highlights: Double,
    val shadows: Double,
)

data class PreparedImage(val dataUrl: String, val w: Int, val h: Int, val stats: ImageStats)

/** Image work that differs per platform (the web demo uses a canvas). */
interface ImageTools {
    /** Downscales a JPEG so its long side is at most [maxSide], re-encodes it, and measures it. */
    suspend fun prepare(jpeg: ByteArray, maxSide: Int, quality: Double = 0.8): PreparedImage
}

fun statsLine(s: ImageStats) =
    "Brightness: mean ${s.mean}/255, centre ${s.center}/255; clipped highlights ${pct(s.highlights)}%, crushed shadows ${pct(s.shadows)}%."

/** One decimal, without a trailing ".0" (as JavaScript prints a rounded number). */
private fun pct(v: Double): String {
    val r = (v * 10).roundToInt() / 10.0
    return if (r == Math.floor(r)) r.toLong().toString() else r.toString()
}

/** Luminance statistics of 8-bit ARGB pixels, the same measures the web demo computes. */
fun measure(pixels: IntArray, w: Int, h: Int): ImageStats {
    var sum = 0.0
    var centerSum = 0.0
    var centerN = 0
    var hi = 0
    var lo = 0
    val x0 = w / 3
    val x1 = 2 * w / 3
    val y0 = h / 3
    val y1 = 2 * h / 3
    for (y in 0 until h) {
        for (x in 0 until w) {
            val p = pixels[y * w + x]
            val l = 0.2126 * ((p shr 16) and 0xff) + 0.7152 * ((p shr 8) and 0xff) + 0.0722 * (p and 0xff)
            sum += l
            if (l >= 250) hi++
            if (l <= 6) lo++
            if (x in x0 until x1 && y in y0 until y1) {
                centerSum += l
                centerN++
            }
        }
    }
    val n = max(1, w * h).toDouble()
    return ImageStats(
        mean = (sum / n).roundToInt(),
        center = if (centerN > 0) (centerSum / centerN).roundToInt() else 0,
        highlights = (hi / n * 1000).roundToInt() / 10.0,
        shadows = (lo / n * 1000).roundToInt() / 10.0,
    )
}

class AndroidImageTools : ImageTools {
    override suspend fun prepare(jpeg: ByteArray, maxSide: Int, quality: Double): PreparedImage = withContext(Dispatchers.Default) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        // Decode at a power-of-two reduction first: originals can be 24+ megapixels.
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalArgumentException("The camera sent an image that couldn't be decoded")
        val scale = minOf(1.0, maxSide.toDouble() / max(decoded.width, decoded.height))
        val bmp = if (scale < 1.0) {
            Bitmap.createScaledBitmap(decoded, (decoded.width * scale).roundToInt(), (decoded.height * scale).roundToInt(), true)
        } else decoded
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, (quality * 100).roundToInt(), out)
        val pixels = IntArray(bmp.width * bmp.height)
        bmp.getPixels(pixels, 0, bmp.width, 0, 0, bmp.width, bmp.height)
        val stats = measure(pixels, bmp.width, bmp.height)
        val url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        PreparedImage(url, bmp.width, bmp.height, stats)
    }
}
