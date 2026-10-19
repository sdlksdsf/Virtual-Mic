package app.voxbridge.mic

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Notification action bridge. Kept exported=false; only the system can fire it. */
class ServiceActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MicService.stop(context)
    }
}
