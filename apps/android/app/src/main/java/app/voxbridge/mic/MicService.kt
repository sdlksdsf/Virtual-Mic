package app.voxbridge.mic

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.voxbridge.mic.audio.AdpcmEncoder
import app.voxbridge.mic.audio.Dsp
import app.voxbridge.mic.audio.LevelMeter
import app.voxbridge.mic.net.ConnectionState
import app.voxbridge.mic.net.MicClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Foreground capture service. Owns the AudioRecord instance, the DSP chain and
 * the socket, so audio survives the screen turning off and the activity being
 * destroyed.
 */
class MicService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var prefs: app.voxbridge.mic.data.Prefs
    private var record: AudioRecord? = null
    private var captureJob: Job? = null
    private var hwDenoise: NoiseSuppressor? = null
    private var hwAgc: AutomaticGainControl? = null
    private var hwAec: AcousticEchoCanceler? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val encodeLock = Any()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = (application as VoxBridgeApp).prefs
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_MUTE -> {
                Session.muted = !Session.muted
                // Muting happens locally so no audio leaves the phone at all; the
                // desktop is told only so both screens agree.
                Session.client?.sendMute(Session.muted)
                updateNotification()
                Session.emitState()
                return START_STICKY
            }
            ACTION_CONNECT -> {
                val host = intent.getStringExtra(EXTRA_HOST) ?: prefs.lastHost
                val port = intent.getIntExtra(EXTRA_PORT, 8720)
                val code = intent.getStringExtra(EXTRA_CODE) ?: prefs.lastCode
                if (host.isNullOrBlank()) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                Session.targetName = intent.getStringExtra(EXTRA_NAME) ?: host
                ensureNotification()
                connect(host, port, code)
                return START_STICKY
            }
            else -> {
                ensureNotification()
                return START_STICKY
            }
        }
    }

    private fun connect(host: String, port: Int, code: String?) {
        val client = MicClient { event ->
            when (event) {
                is MicClient.Event.State -> {
                    Session.connection = event.state
                    Session.detail = event.detail
                    updateNotification()
                    Session.emitState()
                }
                is MicClient.Event.Welcome -> {
                    Session.hostName = event.name
                    Session.auth = event.auth
                    prefs.lastHost = host
                    prefs.lastCode = code
                    applyStreamConfig(event.stream.rate, event.stream.codec, event.stream.frameMs)
                    startCapture()
                }
                is MicClient.Event.Denied -> {
                    Session.detail = event.hint.ifBlank { event.reason }
                    Session.connection = ConnectionState.Failed
                    updateNotification()
                    Session.emitState()
                }
                is MicClient.Event.Config -> {
                    applyStreamConfig(event.stream.rate, event.stream.codec, event.stream.frameMs, restart = true)
                }
                is MicClient.Event.RemoteStats -> {
                    Session.stats.value = event.stats
                }
                is MicClient.Event.RemoteMute -> {
                    Session.muted = event.on
                    updateNotification()
                    Session.emitState()
                }
                is MicClient.Event.Log -> Session.log(event.message)
            }
        }
        Session.client = client
        Session.targetHost = host
        Session.targetPort = port
        Session.muted = false
        client.connect(
            host = host,
            port = port,
            code = code,
            token = if (prefs.rememberDevice) prefs.token else null,
            deviceName = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}",
            deviceId = prefs.deviceId,
        )
        scope.launch {
            while (isActive) {
                delay(1000)
                client.tick()
                client.reportQuality(Session.stats.value.rtt, 0.0)
                Session.emitState()
                Session.heartbeat()
            }
        }
    }

    private fun applyStreamConfig(rate: Int, codec: String, frameMs: Int, restart: Boolean = false) {
        val changed = rate != Session.rate || codec != Session.codec || frameMs != Session.frameMs
        Session.rate = rate
        Session.codec = codec
        Session.frameMs = frameMs
        prefs.rate = rate
        prefs.codec = codec
        prefs.frameMs = frameMs
        if (restart && changed) {
            startCapture(force = true)
        }
    }

    private fun openRecorder(
        source: Int,
        rate: Int,
        bufferBytes: Int,
    ): AudioRecord? = try {
        val candidate = AudioRecord(
            source,
            rate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        if (candidate.state == AudioRecord.STATE_INITIALIZED) candidate else {
            candidate.release()
            null
        }
    } catch (_: Exception) {
        null
    }

    private fun startCapture(force: Boolean = false) {
        if (captureJob?.isActive == true && !force) return
        captureJob?.cancel()
        record?.release()
        releaseEffects()
        record = null

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Session.connection = ConnectionState.Failed
            Session.detail = "Microphone permission was not granted."
            Session.emitState()
            return
        }

        val rate = Session.rate
        val frameMs = Session.frameMs
        val frameSamples = rate * frameMs / 1000
        val minBuffer = AudioRecord.getMinBufferSize(
            rate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            Session.detail = "This phone could not open a ${rate / 1000} kHz capture stream."
            Session.emitState()
            return
        }
        // Never use VOICE_COMMUNICATION: it enables the platform's echo
        // canceller, noise suppressor and AGC, which fight our own chain and
        // are the main reason phone capture sounds robotic. UNPROCESSED gives
        // the raw capsule where the firmware offers it, so try it first and
        // fall back to the plain microphone.
        val bufferBytes = maxOf(minBuffer * 2, frameSamples * 4 * 2)
        val recorder = openRecorder(MediaRecorder.AudioSource.UNPROCESSED, rate, bufferBytes)
            ?: openRecorder(MediaRecorder.AudioSource.MIC, rate, bufferBytes)
        if (recorder == null) {
            Session.detail = "Capture failed"
            Session.emitState()
            return
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            Session.detail = "Microphone is busy in another app."
            Session.emitState()
            return
        }
        record = recorder

        // Deliberately leave every platform effect switched off. Running the
        // system suppressor and AGC *and* our own chain applies two different
        // noise models in series, which hollows out the voice and re-injects
        // the pumping the software chain just removed.
        try {
            if (NoiseSuppressor.isAvailable()) {
                hwDenoise = NoiseSuppressor.create(recorder.audioSessionId)?.apply { enabled = false }
            }
            if (AutomaticGainControl.isAvailable()) {
                hwAgc = AutomaticGainControl.create(recorder.audioSessionId)?.apply { enabled = false }
            }
            if (AcousticEchoCanceler.isAvailable()) {
                hwAec = AcousticEchoCanceler.create(recorder.audioSessionId)?.apply { enabled = false }
            }
        } catch (_: Exception) {
            // ignored by design
        }

        acquireWakeLock()
        val dsp = Dsp(
            sampleRate = rate,
            denoise = prefs.denoise,
            gateOn = prefs.gate,
            agcOn = prefs.agc,
            limiterOn = prefs.limiter,
            gainDb = prefs.inputGainDb,
        )
        val encoder = AdpcmEncoder()
        val meter = LevelMeter()
        Session.meter = meter
        Session.dsp = dsp
        val buffer = ShortArray(frameSamples)
        val adpcm = Session.codec == "adpcm"
        var seq = 0

        captureJob = scope.launch(Dispatchers.IO) {
            try {
                recorder.startRecording()
                Session.connection = ConnectionState.Connected
                Session.emitState()
                while (isActive) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read <= 0) {
                        if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) {
                            Session.detail = "The microphone stream stopped."
                            break
                        }
                        continue
                    }
                    meter.update(buffer, read)
                    if (!Session.muted) {
                        dsp.process(buffer, read)
                    } else {
                        java.util.Arrays.fill(buffer, 0, read, 0)
                    }
                    val payload = synchronized(encodeLock) {
                        if (adpcm) {
                            encoder.encode(buffer, read)
                        } else {
                            val bytes = ByteArray(read * 2)
                            for (i in 0 until read) {
                                val v = buffer[i].toInt()
                                bytes[i * 2] = (v and 0xff).toByte()
                                bytes[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
                            }
                            bytes
                        }
                    }
                    Session.client?.sendAudio(
                        MicClient.packet(if (adpcm) 1 else 0, seq, payload)
                    )
                    seq = (seq + 1) and 0xffff
                }
            } catch (error: Exception) {
                Session.log("Capture stopped: ${error.message}")
            } finally {
                try {
                    recorder.stop()
                } catch (_: Exception) {
                    // ignore
                }
                recorder.release()
                releaseWakeLock()
            }
        }
    }

    private fun releaseEffects() {
        hwDenoise?.release(); hwDenoise = null
        hwAgc?.release(); hwAgc = null
        hwAec?.release(); hwAec = null
    }

    private fun acquireWakeLock() {
        try {
            val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voxbridge:capture").apply {
                setReferenceCounted(false)
                acquire(4 * 60 * 60 * 1000L)
            }
        } catch (_: Exception) {
            // ignore
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
            // ignore
        }
        wakeLock = null
    }

    private fun ensureNotification() {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = buildNotification(open)
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
        )
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        manager.notify(NOTIFICATION_ID, buildNotification(open))
    }

    private fun buildNotification(open: PendingIntent): Notification {
        val connecting = Session.connection == ConnectionState.Connecting
        val title = if (connecting) "Connecting to ${Session.targetName}" else Session.targetName.ifBlank { "VoxBridge" }
        val text = when {
            Session.connection == ConnectionState.Connected && Session.muted -> "Muted · tap to unmute"
            Session.connection == ConnectionState.Connected -> "Live · ${Session.rate / 1000} kHz ${if (Session.codec == "adpcm") "ADPCM" else "PCM"}"
            Session.connection == ConnectionState.Failed -> Session.detail.ifBlank { "Connection failed" }
            else -> getString(R.string.service_idle)
        }
        val muteIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, MicService::class.java).setAction(ACTION_MUTE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, MicService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, VoxBridgeApp.CHANNEL_STREAM)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(
                0,
                if (Session.muted) "Unmute" else "Mute",
                muteIntent,
            )
            .addAction(0, "Stop", stopIntent)
            .build()
    }

    override fun onDestroy() {
        isRunning = false
        captureJob?.cancel()
        Session.client?.disconnect()
        Session.client = null
        record?.release()
        record = null
        releaseEffects()
        releaseWakeLock()
        scope.cancel()
        Session.connection = ConnectionState.Idle
        Session.emitState()
        super.onDestroy()
    }

    companion object {
        const val ACTION_CONNECT = "app.voxbridge.mic.CONNECT"
        const val ACTION_STOP = "app.voxbridge.mic.STOP"
        const val ACTION_MUTE = "app.voxbridge.mic.MUTE"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_CODE = "code"
        const val EXTRA_NAME = "name"
        private const val NOTIFICATION_ID = 8720

        @Volatile
        var isRunning = false

        fun start(context: Context, host: String, port: Int, code: String?, name: String) {
            val intent = Intent(context, MicService::class.java).apply {
                action = ACTION_CONNECT
                putExtra(EXTRA_HOST, host)
                putExtra(EXTRA_PORT, port)
                putExtra(EXTRA_CODE, code)
                putExtra(EXTRA_NAME, name)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, MicService::class.java).setAction(ACTION_STOP))
        }
    }
}

/** Process-wide session state shared by the service and the UI. */
object Session {
    @Volatile var client: MicClient? = null
    @Volatile var connection: ConnectionState = ConnectionState.Idle
    @Volatile var detail: String = ""
    @Volatile var hostName: String = ""
    @Volatile var targetName: String = ""
    @Volatile var targetHost: String = ""
    @Volatile var targetPort: Int = 8720
    @Volatile var auth: String = ""
    @Volatile var muted: Boolean = false
    @Volatile var rate: Int = 48000
    @Volatile var codec: String = "pcm16"
    @Volatile var frameMs: Int = 20
    @Volatile var meter: LevelMeter? = null
    @Volatile var dsp: Dsp? = null

    val stats = kotlinx.coroutines.flow.MutableStateFlow(app.voxbridge.mic.net.SessionStats())
    private val stateFlow = kotlinx.coroutines.flow.MutableStateFlow(0)
    val state: kotlinx.coroutines.flow.StateFlow<Int> = stateFlow
    private val logs = java.util.Collections.synchronizedList(ArrayList<String>())

    fun emitState() {
        stateFlow.value = stateFlow.value + 1
    }

    fun log(message: String) {
        logs.add("[${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}] $message")
        if (logs.size > 80) logs.removeAt(0)
    }

    fun logLines(): List<String> = logs.toList()

    fun heartbeat() {
        val m = meter ?: return
        stats.value = stats.value.copy(
            level = m.rms,
            peak = m.peak,
            packetsSent = client?.stats?.value?.packetsSent ?: stats.value.packetsSent,
        )
    }

    fun describe(): JSONObject = JSONObject()
        .put("state", connection.name)
        .put("detail", detail)
        .put("host", targetHost)
        .put("name", hostName)
        .put("rate", rate)
        .put("codec", codec)
        .put("muted", muted)
}
