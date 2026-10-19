package app.voxbridge.mic

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.StrictMode
import app.voxbridge.mic.data.Prefs
import app.voxbridge.mic.net.Discovery
import app.voxbridge.mic.net.HostStore

class VoxBridgeApp : Application() {

    lateinit var prefs: Prefs
        private set
    lateinit var hostStore: HostStore
        private set
    lateinit var discovery: Discovery
        private set

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        hostStore = HostStore(this)
        discovery = Discovery(this)
        createChannels()
        if (BuildConfig.DEBUG) {
            StrictMode.setThreadPolicy(
                StrictMode.ThreadPolicy.Builder().detectDiskReads().penaltyLog().build()
            )
        }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val stream = NotificationChannel(
            CHANNEL_STREAM,
            getString(R.string.channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.channel_description)
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        val alerts = NotificationChannel(
            CHANNEL_ALERTS,
            "Connection notices",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Pairing failures and lost sessions."
            setShowBadge(true)
        }
        manager.createNotificationChannels(listOf(stream, alerts))
    }

    companion object {
        const val CHANNEL_STREAM = "stream"
        const val CHANNEL_ALERTS = "alerts"
    }
}
