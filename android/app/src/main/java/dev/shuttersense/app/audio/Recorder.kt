package dev.shuttersense.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Push-to-talk capture: mono 16-bit PCM at 24 kHz, wrapped as WAV for Muse
 * Voice Transcribe (through the worker). Same format as the web app's recorder.
 */
class Recorder {
    private var record: AudioRecord? = null
    private var pcm = ByteArrayOutputStream()
    @Volatile var recording = false
        private set

    companion object {
        const val RATE = 24_000
        const val MAX_SECONDS = 45
    }

    /** Starts recording; requires RECORD_AUDIO. Blocks the calling (IO) thread until [stop]. */
    @SuppressLint("MissingPermission")
    suspend fun record() = withContext(Dispatchers.IO) {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            throw IllegalStateException("The microphone isn't available")
        }
        record = r
        pcm = ByteArrayOutputStream()
        recording = true
        r.startRecording()
        val buf = ByteArray(4096)
        val limit = RATE * 2 * MAX_SECONDS
        try {
            while (recording && pcm.size() < limit) {
                val n = r.read(buf, 0, buf.size)
                if (n > 0) pcm.write(buf, 0, n)
            }
        } finally {
            recording = false
            r.stop()
            r.release()
            record = null
        }
    }

    /** Stops and returns WAV bytes, or null for an accidental tap (under 300 ms). */
    fun stop(): ByteArray? {
        recording = false
        val data = pcm.toByteArray()
        if (data.size < RATE * 2 * 3 / 10) return null
        return wav(data, RATE)
    }

    private fun wav(pcm: ByteArray, rate: Int): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(pcm.size)
        return header.array() + pcm
    }
}
