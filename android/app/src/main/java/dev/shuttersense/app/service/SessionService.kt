package dev.shuttersense.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.ContextCompat
import dev.shuttersense.app.R
import dev.shuttersense.app.ui.MainActivity

// Keeps the app running with the screen locked. The camera link, the agent
// run and the glasses session all live in the app's process; once the screen
// locks, Android would freeze a background app within seconds and the
// glasses would lose their connection. A foreground service (with its
// ongoing notification) keeps the process going, a partial wake lock keeps
// the CPU up for the agent and the glasses socket, and a Wi-Fi lock keeps
// the radio from dozing between camera requests. It holds no state itself.

class SessionService : Service() {
    companion object {
        private const val CHANNEL = "session"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_TEXT = "text"

        @Volatile private var running = false

        /** Starts the service with [text] as its notification, or updates the text if it's running. */
        fun show(context: Context, text: String) {
            val app = context.applicationContext
            if (running) {
                app.getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(app, text))
                return
            }
            try {
                ContextCompat.startForegroundService(app, Intent(app, SessionService::class.java).putExtra(EXTRA_TEXT, text))
            } catch (_: Exception) {
                // Android refuses to start one from the background; the next change in the foreground starts it.
            }
        }

        fun hide(context: Context) {
            if (!running) return
            context.applicationContext.stopService(Intent(context.applicationContext, SessionService::class.java))
        }

        private fun notification(context: Context, text: String): Notification {
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_session)
                .setContentTitle("Shutter Sense is running")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build()
        }
    }

    private var wake: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Camera and glasses session", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the app keeps the camera and glasses connected."
                setShowBadge(false)
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = notification(this, intent?.getStringExtra(EXTRA_TEXT) ?: "Connected")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
        running = true
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ShutterSense:session")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock == null) {
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = applicationContext.getSystemService(WifiManager::class.java)?.createWifiLock(mode, "ShutterSense:camera")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        wake?.takeIf { it.isHeld }?.release()
        wake = null
        wifiLock?.takeIf { it.isHeld }?.release()
        wifiLock = null
        super.onDestroy()
    }
}
