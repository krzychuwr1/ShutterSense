package dev.shuttersense.app.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import okhttp3.Dns
import okhttp3.OkHttpClient
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import javax.net.SocketFactory

// Which network each kind of traffic uses. A camera's own Wi-Fi usually has
// no internet, yet Android may keep it as the default network; then the agent
// server is unreachable. So camera requests are pinned to Wi-Fi, and agent
// server requests (agent, voice, glasses relay) go over mobile data whenever
// the default network can't reach the internet. Other apps aren't affected.

object Networks {
    private var cm: ConnectivityManager? = null

    @Volatile private var wifi: Network? = null

    @Volatile private var cellular: Network? = null

    /** Starts tracking Wi-Fi and keeps a mobile-data network available. Safe to call more than once. */
    fun init(context: Context) {
        if (cm != null) return
        val c = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
        cm = c
        c.registerNetworkCallback(
            NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { wifi = network }
                override fun onLost(network: Network) { if (wifi == network) wifi = null }
            },
        )
        // Asking for it keeps mobile data up next to a Wi-Fi without internet (if mobile data is on at all).
        try {
            c.requestNetwork(
                NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) { cellular = network }
                    override fun onLost(network: Network) { if (cellular == network) cellular = null }
                },
            )
        } catch (_: SecurityException) {
            // without the permission, internet traffic stays on the default network
        }
    }

    /** The camera's Wi-Fi joined from the app, else whatever Wi-Fi the phone is on. */
    private fun cameraNetwork(): Network? = CameraWifi.network ?: wifi

    /** The network for internet traffic, or null when the default network already reaches the internet. */
    private fun internet(): Network? {
        val c = cm ?: return null
        val caps = c.activeNetwork?.let { c.getNetworkCapabilities(it) }
        if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return null
        return cellular
    }

    /** Routes [builder]'s connections to the camera at [host] over Wi-Fi. */
    fun forCamera(builder: OkHttpClient.Builder, host: String): OkHttpClient.Builder {
        if (isLocalOnly(host)) return builder
        return builder.socketFactory(RoutedSocketFactory(::cameraNetwork)).dns(routedDns(::cameraNetwork))
    }

    /** Routes [builder]'s connections to the agent server at [host] over a network that reaches the internet. */
    fun forInternet(builder: OkHttpClient.Builder, host: String): OkHttpClient.Builder {
        if (isLocalOnly(host) || isPrivate(host)) return builder
        return builder.socketFactory(RoutedSocketFactory(::internet)).dns(routedDns(::internet))
    }

    /** Sends [socket]'s datagrams (camera discovery) over Wi-Fi. */
    fun bindToWifi(socket: DatagramSocket) {
        try {
            cameraNetwork()?.bindSocket(socket)
        } catch (_: Exception) {
            // the default network still works on most setups
        }
    }

    /** This device itself (USB port forwarding, the emulator's host alias): never re-route. */
    private fun isLocalOnly(host: String) = host == "localhost" || host.startsWith("127.") || host == "10.0.2.2" || host == "::1"

    private fun isPrivate(host: String): Boolean {
        val p = host.split(".").mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31)
    }

    private fun routedDns(pick: () -> Network?): Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = pick()?.getAllByName(hostname)?.toList() ?: Dns.SYSTEM.lookup(hostname)
    }

    /** Creates each socket on whichever network [pick] says at that moment; the default network when it says none. */
    private class RoutedSocketFactory(private val pick: () -> Network?) : SocketFactory() {
        private fun factory(): SocketFactory = pick()?.socketFactory ?: getDefault()
        override fun createSocket(): Socket = factory().createSocket()
        override fun createSocket(host: String, port: Int): Socket = factory().createSocket(host, port)
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            factory().createSocket(host, port, localHost, localPort)
        override fun createSocket(host: InetAddress, port: Int): Socket = factory().createSocket(host, port)
        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            factory().createSocket(address, port, localAddress, localPort)
    }
}
