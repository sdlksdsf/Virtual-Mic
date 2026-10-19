package app.voxbridge.mic.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Settings that survive restarts. Audio parameters intentionally mirror the
 * values documented in docs/PROTOCOL.md so both ends agree.
 */
class Prefs(context: Context) {

    private val sp: SharedPreferences =
        context.getSharedPreferences("voxbridge.xml", Context.MODE_PRIVATE)

    var theme: String
        get() = sp.getString("theme", "system") ?: "system"
        set(value) = sp.edit { putString("theme", value) }

    var lastHost: String?
        get() = sp.getString("last_host", null)
        set(value) = sp.edit { putString("last_host", value) }

    var lastCode: String?
        get() = sp.getString("last_code", null)
        set(value) = sp.edit { putString("last_code", value) }

    var rememberDevice: Boolean
        get() = sp.getBoolean("remember", true)
        set(value) = sp.edit { putBoolean("remember", value) }

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit { putString("token", value) }

    var deviceId: String
        get() = sp.getString("device_id", null) ?: java.util.UUID.randomUUID().toString().also {
            sp.edit { putString("device_id", it) }
        }
        set(value) = sp.edit { putString("device_id", value) }

    var rate: Int
        get() = sp.getInt("rate", 48000)
        set(value) = sp.edit { putInt("rate", value) }

    var codec: String
        get() = sp.getString("codec", "pcm16") ?: "pcm16"
        set(value) = sp.edit { putString("codec", value) }

    var frameMs: Int
        get() = sp.getInt("frame_ms", 20)
        set(value) = sp.edit { putInt("frame_ms", value) }

    var denoise: Int
        get() = sp.getInt("denoise", 3)
        set(value) = sp.edit { putInt("denoise", value) }

    var agc: Boolean
        get() = sp.getBoolean("agc", true)
        set(value) = sp.edit { putBoolean("agc", value) }

    var gate: Boolean
        get() = sp.getBoolean("gate", true)
        set(value) = sp.edit { putBoolean("gate", value) }

    var limiter: Boolean
        get() = sp.getBoolean("limiter", true)
        set(value) = sp.edit { putBoolean("limiter", value) }

    var inputGainDb: Int
        get() = sp.getInt("input_gain", 0)
        set(value) = sp.edit { putInt("input_gain", value) }

    var headsetMic: Boolean
        get() = sp.getBoolean("headset_mic", false)
        set(value) = sp.edit { putBoolean("headset_mic", value) }

    var keepScreenOff: Boolean
        get() = sp.getBoolean("screen_off", true)
        set(value) = sp.edit { putBoolean("screen_off", value) }
}
