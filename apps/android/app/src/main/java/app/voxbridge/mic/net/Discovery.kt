package app.voxbridge.mic.net

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.SocketTimeoutException

data class DiscoveredHost(
    val name: String,
    val address: String,
    val port: Int,
    val needsPairing: Boolean,
    val version: String,
    val seenAt: Long,
)

/**
 * Listens for the desktop announcement documented in docs/PROTOCOL.md §2.
 * Discovery is best-effort: manual addresses always remain available because
 * guest Wi-Fi and client isolation routinely block broadcasts.
 */
class Discovery(private val context: Context) {

    private val _hosts = MutableStateFlow<List<DiscoveredHost>>(emptyList())
    val hosts: StateFlow<List<DiscoveredHost>> = _hosts

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning

    private var job: Job? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    fun start(scope: CoroutineScope) {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            _scanning.value = true
            acquireLock()
            val socket = try {
                DatagramSocket(8721).apply {
                    broadcast = true
                    soTimeout = 1200
                    reuseAddress = true
                }
            } catch (error: Exception) {
                _scanning.value = false
                return@launch
            }
            val buffer = ByteArray(1024)
            try {
                while (true) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val text = String(packet.data, 0, packet.length)
                        parse(text, packet.address.hostAddress ?: continue)?.let(::upsert)
                    } catch (_: SocketTimeoutException) {
                        prune()
                    } catch (_: Exception) {
                        break
                    }
                }
            } finally {
                socket.close()
                releaseLock()
                _scanning.value = false
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        _scanning.value = false
        releaseLock()
    }

    fun clear() {
        _hosts.value = emptyList()
    }

    private fun parse(text: String, address: String): DiscoveredHost? = try {
        val json = JSONObject(text)
        if (json.optInt("voxbridge", 0) != 1) null
        else DiscoveredHost(
            name = json.optString("name", "PC"),
            address = address,
            port = json.optInt("port", 8720),
            needsPairing = json.optBoolean("pair", true),
            version = json.optString("version", ""),
            seenAt = System.currentTimeMillis(),
        )
    } catch (_: Exception) {
        null
    }

    private fun upsert(host: DiscoveredHost) {
        val current = _hosts.value.toMutableList()
        current.removeAll { it.address == host.address && it.port == host.port }
        current.add(0, host)
        _hosts.value = current
    }

    private fun prune() {
        val cutoff = System.currentTimeMillis() - 6000
        _hosts.value = _hosts.value.filter { it.seenAt > cutoff }
    }

    private fun acquireLock() {
        try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifi.createMulticastLock("voxbridge-discovery").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            // Not fatal; broadcast may still work.
        }
    }

    private fun releaseLock() {
        try {
            multicastLock?.release()
        } catch (_: Exception) {
            // ignore
        }
        multicastLock = null
    }
}
