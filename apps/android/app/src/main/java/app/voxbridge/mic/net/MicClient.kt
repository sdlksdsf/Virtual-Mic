package app.voxbridge.mic.net

import app.voxbridge.mic.BuildConfig
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

enum class ConnectionState { Idle, Connecting, Connected, Failed, Closed }

data class SessionStats(
    val rtt: Int = 0,
    val jitter: Int = 0,
    val lost: Int = 0,
    val buffer: Int = 0,
    val bitrate: Double = 0.0,
    val level: Float = 0f,
    val peak: Float = 0f,
    val packetsSent: Long = 0,
)

data class StreamConfig(
    val rate: Int = 48000,
    val codec: String = "pcm16",
    val frameMs: Int = 20,
)

/**
 * WebSocket client for the desktop receiver. Implements docs/PROTOCOL.md:
 * hello → welcome, binary audio frames, ping/pong, stats and config.
 */
class MicClient(private val onEvent: (Event) -> Unit) {

    sealed class Event {
        data class State(val state: ConnectionState, val detail: String = "") : Event()
        data class Welcome(val name: String, val auth: String, val stream: StreamConfig) : Event()
        data class Denied(val reason: String, val hint: String) : Event()
        data class RemoteStats(val stats: SessionStats) : Event()
        data class Config(val stream: StreamConfig) : Event()
        data class RemoteMute(val on: Boolean) : Event()
        data class Log(val message: String) : Event()
    }

    private val _state = MutableStateFlow(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state

    private val _stats = MutableStateFlow(SessionStats())
    val stats: StateFlow<SessionStats> = _stats

    private val _config = MutableStateFlow(StreamConfig())
    val config: StateFlow<StreamConfig> = _config

    private val _audio = MutableSharedFlow<ByteArray>(
        replay = 0,
        extraBufferCapacity = 24,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val audio: SharedFlow<ByteArray> = _audio

    private var socket: WebSocket? = null
    private var lastPingAt = 0L
    private var lastPingId = 0
    private var packetsSent = 0L
    private var welcome = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        // Protocol-level keepalive. When the phone's Wi-Fi radio naps with the
        // screen off, the socket can go silent without ever closing; a ping
        // every 15 s detects that in seconds and lets the service reconnect
        // instead of streaming into a dead link.
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    @Synchronized
    fun connect(host: String, port: Int, code: String?, token: String?, deviceName: String, deviceId: String, caps: List<String> = listOf("pcm16", "adpcm", "stats")) {
        disconnect()
        _state.value = ConnectionState.Connecting
        onEvent(Event.State(ConnectionState.Connecting))
        val url = "ws://$host:$port/mic"
        val hello = JSONObject()
            .put("t", "hello")
            .put("v", 1)
            .put("name", deviceName)
            .put("device", "android")
            .put("code", code ?: "")
            .put("token", token ?: "")
            .put("deviceId", deviceId)
            .put("app", BuildConfig.VERSION_NAME)
            .put("caps", org.json.JSONArray(caps))
        welcome = false
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(hello.toString())
                onEvent(Event.Log("Socket opened"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleText(webSocket, text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                _audio.tryEmit(bytes.toByteArray())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (_state.value == ConnectionState.Closed) return
                _state.value = ConnectionState.Failed
                onEvent(Event.State(ConnectionState.Failed, t.message ?: "connection failed"))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                val mapped = when (code) {
                    4401 -> "Pairing code rejected. Ask the PC for the current code."
                    4408 -> "Session timed out."
                    4429 -> "Too many attempts. Wait a minute, then retry."
                    else -> reason.ifBlank { "Disconnected" }
                }
                if (_state.value != ConnectionState.Closed) {
                    _state.value = ConnectionState.Failed
                    onEvent(Event.State(ConnectionState.Failed, mapped))
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (_state.value != ConnectionState.Closed) {
                    _state.value = ConnectionState.Closed
                    onEvent(Event.State(ConnectionState.Closed, reason))
                }
            }
        })
    }

    private fun handleText(webSocket: WebSocket, text: String) {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (json.optString("t")) {
            "welcome" -> {
                welcome = true
                _state.value = ConnectionState.Connected
                val stream = StreamConfig(
                    rate = json.optJSONObject("stream")?.optInt("rate", 48000) ?: 48000,
                    codec = json.optJSONObject("stream")?.optString("codec", "pcm16") ?: "pcm16",
                    frameMs = json.optJSONObject("stream")?.optInt("frame_ms", 20) ?: 20,
                )
                _config.value = stream
                onEvent(
                    Event.Welcome(
                        name = json.optString("name", "PC"),
                        auth = json.optString("auth", "code"),
                        stream = stream,
                    )
                )
                onEvent(Event.State(ConnectionState.Connected))
            }
            "denied" -> {
                onEvent(Event.Denied(json.optString("reason"), json.optString("hint")))
                webSocket.close(4401, "denied")
            }
            "stats" -> {
                val stats = SessionStats(
                    rtt = json.optInt("rtt", _stats.value.rtt),
                    jitter = json.optInt("jitter", 0),
                    lost = json.optInt("lost", 0),
                    buffer = json.optInt("buffer", 0),
                    bitrate = json.optDouble("bitrate", 0.0),
                    level = json.optDouble("level", 0.0).toFloat(),
                    peak = json.optDouble("peak", 0.0).toFloat(),
                    packetsSent = packetsSent,
                )
                _stats.value = stats
                onEvent(Event.RemoteStats(stats))
            }
            "config" -> {
                val stream = json.optJSONObject("stream") ?: return
                val config = StreamConfig(
                    rate = stream.optInt("rate", 48000),
                    codec = stream.optString("codec", "pcm16"),
                    frameMs = stream.optInt("frame_ms", 20),
                )
                _config.value = config
                onEvent(Event.Config(config))
            }
            "mute" -> onEvent(Event.RemoteMute(json.optBoolean("on", false)))
            "ping" -> {
                val pong = JSONObject()
                    .put("t", "pong")
                    .put("id", json.optInt("id", 0))
                    .put("ts", json.optLong("ts", 0))
                webSocket.send(pong.toString())
            }
            "pong" -> {
                val rtt = (System.currentTimeMillis() - lastPingAt).toInt().coerceIn(0, 999)
                _stats.value = _stats.value.copy(rtt = rtt)
            }
            "bye" -> webSocket.close(1000, "bye")
        }
    }

    fun sendAudio(packet: ByteArray): Boolean {
        val socket = socket ?: return false
        if (!welcome) return false
        val ok = socket.send(okio.ByteString.of(*packet))
        if (ok) {
            packetsSent += 1
            _stats.value = _stats.value.copy(packetsSent = packetsSent)
        }
        return ok
    }

    fun tick() {
        val socket = socket ?: return
        val now = System.currentTimeMillis()
        if (now - lastPingAt > 3000) {
            lastPingAt = now
            lastPingId = (lastPingId + 1) and 0xffff
            socket.send(JSONObject().put("t", "ping").put("id", lastPingId).put("ts", now).toString())
        }
    }

    fun sendMute(on: Boolean) {
        socket?.send(JSONObject().put("t", "mute").put("on", on).toString())
    }

    fun reportQuality(rtt: Int, loss: Double) {
        socket?.send(
            JSONObject()
                .put("t", "quality")
                .put("rtt", rtt)
                .put("loss", loss)
                .put("sent", packetsSent)
                .toString()
        )
    }

    @Synchronized
    fun disconnect() {
        welcome = false
        socket?.close(1000, "client closed")
        socket = null
        _state.value = ConnectionState.Closed
    }

    companion object {
        /** Builds a protocol packet. Kept here so both codecs share one header writer. */
        fun packet(codec: Int, seq: Int, payload: ByteArray, flags: Int = 0): ByteArray {
            val out = ByteArray(12 + payload.size)
            out[0] = 0x56
            out[1] = 1
            out[2] = codec.toByte()
            out[3] = flags.toByte()
            out[4] = (seq and 0xff).toByte()
            out[5] = ((seq shr 8) and 0xff).toByte()
            val ts = System.currentTimeMillis()
            out[6] = (ts and 0xff).toByte()
            out[7] = ((ts shr 8) and 0xff).toByte()
            out[8] = ((ts shr 16) and 0xff).toByte()
            out[9] = ((ts shr 24) and 0xff).toByte()
            out[10] = (payload.size and 0xff).toByte()
            out[11] = ((payload.size shr 8) and 0xff).toByte()
            System.arraycopy(payload, 0, out, 12, payload.size)
            return out
        }
    }
}
