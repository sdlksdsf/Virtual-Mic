package app.voxbridge.mic

import android.Manifest
import android.annotation.SuppressLint
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
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
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
import app.voxbridge.mic.system.BackgroundGuard
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
import kotlin.math.min

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
    private var wifiLock: WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var tickJob: Job? = null
    private var reconnectJob: Job? = null

    // Where to reconnect to, captured when the session starts.
    private var sessionHost = ""
    private var sessionPort = 8720
    private var sessionCode: String? = null
    // The user pressed Stop: never bring the session back on its own.
    @Volatile private var stopped = false
    // Pairing was refused: retrying with the same code cannot succeed, so the
    // loop stops and the phone waits for a fresh code.
    @Volatile private var retryBlocked = false
    private var attempt = 0
    // Bumped whenever the capture loop is replaced, so a stalled loop that
    // restarts itself cannot leave two recorders open.
    private var captureToken = 0

    private val encodeLock = Any()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = (application as VoxBridgeApp).prefs
        isRunning = true
        instance = this
        startTicker()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopped = true
                stopCapture()
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
                // The system restarted us after a kill (START_STICKY), or the
                // notification was tapped after the process died. Pick the last
                // session back up so a locked phone reconnects on its own.
                ensureNotification()
                val host = prefs.lastHost
                if (!host.isNullOrBlank() && Session.connection != ConnectionState.Connected) {
                    Session.targetName = host
                    connect(host, 8720, prefs.lastCode)
                }
                return START_STICKY
            }
        }
    }

    /**
     * Starts (or restarts) a session against the desktop. The wake and Wi-Fi
     * locks are taken here, before the first packet, so the radio stays out of
     * power save even while the screen is off and the connection is still being
     * negotiated.
     */
    private fun connect(host: String, port: Int, code: String?) {
        stopped = false
        retryBlocked = false
        attempt = 0
        sessionHost = host
        sessionPort = port
        sessionCode = code
        Session.muted = false
        Session.detail = ""
        applyBackgroundPolicy()
        registerNetwork()
        startClient(force = true)
    }

    @Synchronized
    private fun startClient(force: Boolean = false) {
        if (stopped) return
        val host = sessionHost
        if (host.isBlank()) return
        // A retry must not race a session that is already negotiating or live.
        // An explicit connect is allowed to replace the running one.
        if (!force && (Session.connection == ConnectionState.Connecting ||
                Session.connection == ConnectionState.Connected)
        ) {
            return
        }

        Session.client?.disconnect()
        var self: MicClient? = null
        val client = MicClient { event ->
            // A stale client from a previous attempt must not steer the session.
            if (self != null && self === Session.client) onClientEvent(event)
        }
        self = client
        Session.client = client
        Session.targetHost = host
        Session.targetPort = sessionPort
        client.connect(
            host = host,
            port = sessionPort,
            code = sessionCode,
            token = if (prefs.rememberDevice) prefs.token else null,
            deviceName = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}",
            deviceId = prefs.deviceId,
        )
    }

    private fun onClientEvent(event: MicClient.Event) {
        when (event) {
            is MicClient.Event.State -> {
                val previous = Session.connection
                Session.connection = event.state
                Session.detail = event.detail
                when (event.state) {
                    ConnectionState.Connected -> {
                        attempt = 0
                        Session.retryAttempt = 0
                        Session.nextRetryAt = 0L
                    }
                    ConnectionState.Failed, ConnectionState.Closed -> {
                        if (previous != ConnectionState.Failed && previous != ConnectionState.Closed) {
                            Session.log("Link lost: ${event.detail.ifBlank { event.state.name }}")
                            stopCapture()
                            scheduleReconnect()
                        }
                    }
                    else -> Unit
                }
                updateNotification()
                Session.emitState()
            }
            is MicClient.Event.Welcome -> {
                Session.hostName = event.name
                Session.auth = event.auth
                prefs.lastHost = sessionHost
                prefs.lastCode = sessionCode
                retryBlocked = false
                attempt = 0
                Session.nextRetryAt = 0L
                applyStreamConfig(event.stream.rate, event.stream.codec, event.stream.frameMs)
                startCapture()
            }
            is MicClient.Event.Denied -> {
                retryBlocked = true
                Session.detail = event.hint.ifBlank { event.reason }
                Session.connection = ConnectionState.Failed
                Session.nextRetryAt = 0L
                stopCapture()
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

    /** Exponential backoff, 1 s to 15 s, so a sleeping phone recovers quickly. */
    private fun backoffMs(attempt: Int): Long = min(15_000L, 1_000L shl min(attempt, 4))

    private fun scheduleReconnect() {
        if (stopped || retryBlocked || sessionHost.isBlank()) return
        if (reconnectJob?.isActive == true) return
        val wait = backoffMs(attempt)
        attempt += 1
        Session.retryAttempt = attempt
        Session.nextRetryAt = System.currentTimeMillis() + wait
        Session.log("Reconnecting in ${wait / 1000}s (attempt $attempt)")
        updateNotification()
        reconnectJob = scope.launch {
            delay(wait)
            Session.nextRetryAt = 0L
            if (stopped || retryBlocked) return@launch
            if (Session.connection == ConnectionState.Connected) return@launch
            startClient()
            updateNotification()
            Session.emitState()
        }
    }

    /**
     * When the radio comes back — the screen turned on, Wi-Fi re-associated, a
     * roaming handover finished — reconnect at once instead of waiting out the
     * backoff.
     */
    private fun registerNetwork() {
        if (networkCallback != null) return
        val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (stopped || retryBlocked) return
                if (Session.connection == ConnectionState.Connected) return
                scope.launch {
                    delay(250)
                    if (stopped || retryBlocked) return@launch
                    if (Session.connection == ConnectionState.Connecting) return@launch
                    if (Session.connection == ConnectionState.Connected) return@launch
                    reconnectJob?.cancel()
                    attempt = 0
                    Session.nextRetryAt = 0L
                    Session.log("Network is back — reconnecting")
                    startClient()
                    updateNotification()
                    Session.emitState()
                }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Exception) {
            // Registration is best effort; the backoff loop still recovers.
        }
    }

    private fun unregisterNetwork() {
        val callback = networkCallback ?: return
        networkCallback = null
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)
                ?.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
            // ignore
        }
    }

    /** One heartbeat per second for the whole service lifetime. */
    private fun startTicker() {
        if (tickJob?.isActive == true) return
        tickJob = scope.launch {
            var beats = 0
            while (isActive) {
                delay(1000)
                beats += 1
                Session.client?.let { client ->
                    client.tick()
                    client.reportQuality(Session.stats.value.rtt, 0.0)
                }
                Session.heartbeat()
                Session.emitState()
                // OEM power managers sometimes drop a wake lock after a sweep;
                // take it back while a session is supposed to be live.
                if (beats % 30 == 0 && Session.client != null) applyBackgroundPolicy()
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
        stopCapture()
        val token = ++captureToken

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
                if (record === recorder) record = null
                // The capsule stalled (another app grabbed it, a call came in,
                // or the OEM muted the mic for a moment). Reopen it as long as
                // the session is still meant to be live.
                if (token == captureToken && !stopped &&
                    Session.connection == ConnectionState.Connected
                ) {
                    scope.launch {
                        delay(600)
                        if (token == captureToken && !stopped &&
                            Session.connection == ConnectionState.Connected
                        ) {
                            Session.log("Restarting the microphone after a stall")
                            startCapture()
                        }
                    }
                }
            }
        }
    }

    /** Stops the capture loop and gives the microphone back to the phone. */
    private fun stopCapture() {
        captureToken += 1
        val job = captureJob
        captureJob = null
        job?.cancel()
        // Releasing unblocks a pending read(); the job's finally releases the
        // same instance again, which is safe.
        record?.release()
        record = null
        releaseEffects()
    }

    private fun releaseEffects() {
        hwDenoise?.release(); hwDenoise = null
        hwAgc?.release(); hwAgc = null
        hwAec?.release(); hwAec = null
    }

    /**
     * Keeps the CPU and the Wi-Fi radio awake for the whole session. The old
     * code took a CPU lock only while audio was flowing and let it expire after
     * four hours; if the link dropped with the screen off there was nothing
     * left to reconnect with, which is exactly when the session disappeared.
     */
    private fun applyBackgroundPolicy() {
        if (!prefs.keepScreenOff) {
            releaseWakeLock()
            releaseWifiLock()
            Session.screenOffSafe = false
            return
        }
        acquireWakeLock()
        acquireWifiLock()
        Session.screenOffSafe = wakeLock?.isHeld == true
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        try {
            val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voxbridge:capture").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            // ignore
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireWifiLock() {
        if (wifiLock?.isHeld == true) return
        try {
            val manager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                ?: return
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = manager.createWifiLock(mode, "voxbridge:stream").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            // Some devices refuse the lock; the CPU lock still covers capture.
            wifiLock = null
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

    private fun releaseWifiLock() {
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
            // ignore
        }
        wifiLock = null
    }

    private fun ensureNotification() {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = buildNotification(open)
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0,
            )
        } catch (error: Exception) {
            // Android 14 can refuse a microphone foreground service that the
            // system itself restarted while the app was in the background.
            // Nothing useful can run without the notification, so stop cleanly.
            Session.log("Foreground start refused: ${error.message}")
            stopSelf()
        }
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
        val retrying = Session.nextRetryAt > System.currentTimeMillis()
        val title = when {
            connecting -> "Connecting to ${Session.targetName}"
            // The screen is off and the link dropped: say so, and say that the
            // app is working on it, instead of showing a dead session.
            Session.connection == ConnectionState.Failed && retrying ->
                "Reconnecting to ${Session.targetName}"
            else -> Session.targetName.ifBlank { "VoxBridge" }
        }
        val text = when {
            Session.connection == ConnectionState.Connected && Session.muted -> "Muted · tap to unmute"
            Session.connection == ConnectionState.Connected -> "Live · ${Session.rate / 1000} kHz ${if (Session.codec == "adpcm") "ADPCM" else "PCM"}"
            Session.connection == ConnectionState.Failed && retrying ->
                "Wi-Fi dropped · attempt ${Session.retryAttempt} · ${((Session.nextRetryAt - System.currentTimeMillis()).coerceAtLeast(0) / 1000) + 1}s"
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
        stopped = true
        instance = null
        reconnectJob?.cancel()
        tickJob?.cancel()
        stopCapture()
        Session.client?.disconnect()
        Session.client = null
        unregisterNetwork()
        releaseWakeLock()
        releaseWifiLock()
        scope.cancel()
        Session.connection = ConnectionState.Idle
        Session.nextRetryAt = 0L
        Session.retryAttempt = 0
        Session.screenOffSafe = false
        Session.emitState()
        super.onDestroy()
    }

    /** Applied when the user flips the background switch mid-session. */
    fun refreshBackgroundPolicy() = applyBackgroundPolicy()

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

        /** The live service, so a settings change can take effect immediately. */
        @Volatile
        private var instance: MicService? = null

        fun applyBackgroundPolicy(context: Context) {
            val service = instance ?: return
            if (MicService.isRunning) service.refreshBackgroundPolicy()
        }

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
            try {
                context.startService(Intent(context, MicService::class.java).setAction(ACTION_STOP))
            } catch (_: Exception) {
                // Android 12+ can refuse a background service start; stopping
                // outright is the equivalent outcome.
                context.stopService(Intent(context, MicService::class.java))
            }
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
    /** Epoch millis of the next automatic reconnect, 0 when none is pending. */
    @Volatile var nextRetryAt: Long = 0L
    @Volatile var retryAttempt: Int = 0
    /** True while the CPU and Wi-Fi locks that survive a locked screen are held. */
    @Volatile var screenOffSafe: Boolean = false

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
        .put("retry", retryAttempt)
        .put("retryInMs", (nextRetryAt - System.currentTimeMillis()).coerceAtLeast(0))
        .put("screenOff", screenOffSafe)
}
