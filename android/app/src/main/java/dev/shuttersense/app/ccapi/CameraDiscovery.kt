package dev.shuttersense.app.ccapi

import dev.shuttersense.app.net.Networks
import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL

// Finds cameras on the local network with SSDP: a multicast M-SEARCH for the
// CCAPI service, then each answer's device description, which carries the
// camera's name and its CCAPI address ("http://192.168.1.2:8080/ccapi").

/** A camera that answered the search. */
data class FoundCamera(val name: String, val host: String, val port: Int, val https: Boolean)

object CameraDiscovery {
    const val SEARCH_TARGET = "urn:schemas-canon-com:service:ICPO-CameraControlAPIService:1"
    private const val SSDP_HOST = "239.255.255.250"
    private const val SSDP_PORT = 1900

    private val LOCATION = Regex("""(?im)^location:\s*(\S+)\s*$""")
    private val ACCESS_URL = Regex("""<(?:\w+:)?X_accessURL[^>]*>\s*([^<\s]+)\s*<""", RegexOption.IGNORE_CASE)
    private val FRIENDLY_NAME = Regex("""<friendlyName>\s*([^<]+?)\s*</friendlyName>""", RegexOption.IGNORE_CASE)

    /** Searches for [timeoutMs] and returns every camera that answered, once each. */
    suspend fun search(context: Context, timeoutMs: Long = 3000): List<FoundCamera> = withContext(Dispatchers.IO) {
        val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
        // Without the lock some phones drop multicast traffic to save power.
        val lock = try {
            wifi?.createMulticastLock("shutter-sense-ssdp")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            null
        }
        try {
            locations(timeoutMs).mapNotNull(::describe).distinctBy { "${it.host}:${it.port}" }
        } finally {
            runCatching { lock?.release() }
        }
    }

    private fun locations(timeoutMs: Long): List<String> {
        val found = linkedSetOf<String>()
        val msg = (
            "M-SEARCH * HTTP/1.1\r\n" +
                "HOST: $SSDP_HOST:$SSDP_PORT\r\n" +
                "MAN: \"ssdp:discover\"\r\n" +
                "MX: 2\r\n" +
                "ST: $SEARCH_TARGET\r\n\r\n"
            ).toByteArray()
        DatagramSocket().use { socket ->
            Networks.bindToWifi(socket)
            socket.soTimeout = 400
            val group = InetAddress.getByName(SSDP_HOST)
            val deadline = System.currentTimeMillis() + timeoutMs
            var sent = 0
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < deadline) {
                // Twice, a second apart: UDP gets lost.
                if (sent < 2 && System.currentTimeMillis() >= deadline - timeoutMs + sent * 1000L) {
                    socket.send(DatagramPacket(msg, msg.size, group, SSDP_PORT))
                    sent++
                }
                try {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length)
                    LOCATION.find(text)?.groupValues?.get(1)?.let { found.add(it) }
                } catch (_: SocketTimeoutException) {
                    // keep listening until the deadline
                }
            }
        }
        return found.toList()
    }

    /** Reads a device description; null when it isn't a CCAPI camera. */
    private fun describe(location: String): FoundCamera? = try {
        val c = URL(location).openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        c.readTimeout = 2000
        val xml = try {
            c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
        val access = ACCESS_URL.find(xml)?.groupValues?.get(1)
        val uri = URI(access ?: location)
        val https = uri.scheme.equals("https", ignoreCase = true)
        val port = if (access != null && uri.port > 0) uri.port else if (https) 443 else 8080
        val name = FRIENDLY_NAME.find(xml)?.groupValues?.get(1)?.takeIf { it.isNotBlank() } ?: "Camera"
        val host = uri.host
        if (access == null || host == null) null else FoundCamera(name, host, port, https)
    } catch (_: Exception) {
        null
    }
}
