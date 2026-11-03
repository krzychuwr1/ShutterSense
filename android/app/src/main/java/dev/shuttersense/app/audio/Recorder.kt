package dev.shuttersense.app.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Push-to-talk capture: mono 16-bit PCM at 24 kHz, wrapped as WAV for Muse
 * Voice Transcribe (through the worker). Same format as the web app's recorder.
 * One recording per instance.
 */
class Recorder {
    @Volatile private var stopping = false

    companion object {
        const val RATE = 24_000
        const val MAX_SECONDS = 45
    }

    /**
     * Records until [stop], [MAX_SECONDS] or cancellation; requires RECORD_AUDIO.
     * Returns WAV bytes, or null for an accidental tap (under 300 ms). A [stop]
     * that comes before the microphone is open still ends this recording.
     */
    @SuppressLint("MissingPermission")
    suspend fun record(): ByteArray? = withContext(Dispatchers.IO) {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            throw IllegalStateException("The microphone isn't available")
        }
        val pcm = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        val limit = RATE * 2 * MAX_SECONDS
        try {
            r.startRecording()
            while (!stopping && isActive && pcm.size() < limit) {
                val n = r.read(buf, 0, buf.size)
                // An error (the microphone was taken away, say) ends the recording rather than spinning.
                if (n < 0) break
                pcm.write(buf, 0, n)
            }
        } finally {
            try {
                r.stop()
            } finally {
                r.release()
            }
        }
        val data = pcm.toByteArray()
        if (data.size < RATE * 2 * 3 / 10) null else wav(data, RATE)
    }

    /** Ends the recording [record] is making. */
    fun stop() {
        stopping = true
    }

    private fun wav(pcm: ByteArray, rate: Int): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        header.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(pcm.size)
        return header.array() + pcm
    }
}
