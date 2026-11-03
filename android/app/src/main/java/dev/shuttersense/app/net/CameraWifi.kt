package dev.shuttersense.app.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import kotlinx.coroutines.suspendCancellableCoroutine
import java.net.Inet4Address
import kotlin.coroutines.resume

// Joining the camera's own Wi-Fi from inside the app. Android (10+) connects
// the named network for this app only, after the user confirms in a system
// dialog; every other app keeps the phone's usual connection, so the agent
// server stays reachable over mobile data or the home Wi-Fi. On the camera's
// access point the camera hands out the addresses, so its own address comes
// from the network itself and nobody has to type it.

object CameraWifi {
    /** The app can join a network for itself (Android 10+); older phones join in Settings. */
    val supported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    @Volatile var network: Network? = null
        private set

    @Volatile var ssid: String? = null
        private set

    @Volatile private var callback: ConnectivityManager.NetworkCallback? = null

    /**
     * Joins the network named [name] for this app. Android shows its
     * confirmation dialog; resolves true once connected, false if the user
     * declines or it can't connect (wrong password, out of range).
     */
    suspend fun join(context: Context, name: String, passphrase: String): Boolean {
        if (!supported) return false
        leave(context)
        val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return false
        val spec = WifiNetworkSpecifier.Builder().setSsid(name).apply {
            if (passphrase.isNotEmpty()) setWpa2Passphrase(passphrase)
        }.build()
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // Cameras don't offer internet; don't ask for it.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec)
            .build()
        return suspendCancellableCoroutine { cont ->
            var done = false
            fun finish(ok: Boolean) {
                if (done) return
                done = true
                cont.resume(ok)
            }
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) {
                    network = n
                    ssid = name
                    finish(true)
                }
                override fun onUnavailable() = finish(false)
                override fun onLost(n: Network) {
                    if (network == n) {
                        network = null
                        ssid = null
                    }
                }
            }
            callback = cb
            cm.requestNetwork(request, cb)
            // Only this join's request: a later join may have replaced it.
            cont.invokeOnCancellation { if (callback === cb) leave(context) }
        }
    }

    /**
     * The camera's address on its own access point: the network's DHCP
     * server, or else its gateway. Null when not joined or not known yet.
     */
    fun cameraAddress(context: Context): String? {
        val n = network ?: return null
        val lp = context.applicationContext.getSystemService(ConnectivityManager::class.java)?.getLinkProperties(n) ?: return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            lp.dhcpServerAddress?.hostAddress?.let { return it }
        }
        return lp.routes.mapNotNull { it.gateway as? Inet4Address }.firstOrNull { !it.isAnyLocalAddress }?.hostAddress
    }

    /** Lets go of the camera's Wi-Fi. */
    fun leave(context: Context) {
        val cb = callback ?: return
        callback = null
        network = null
        ssid = null
        try {
            context.applicationContext.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb)
        } catch (_: IllegalArgumentException) {
            // already released
        }
    }
}
