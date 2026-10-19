package app.voxbridge.mic.net

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class SavedHost(
    val name: String,
    val address: String,
    val port: Int = 8720,
    val lastSeen: Long = System.currentTimeMillis(),
)

/** Remembered PCs, newest first. Small JSON file, no database needed. */
class HostStore(context: Context) {

    private val file = context.getSharedPreferences("voxbridge.xml", Context.MODE_PRIVATE)
    private val key = "saved_hosts"

    fun all(): List<SavedHost> {
        val raw = file.getString(key, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            buildList {
                for (i in 0 until array.length()) {
                    val obj = array.getJSONObject(i)
                    add(
                        SavedHost(
                            name = obj.optString("name", "PC"),
                            address = obj.optString("address"),
                            port = obj.optInt("port", 8720),
                            lastSeen = obj.optLong("lastSeen", 0),
                        )
                    )
                }
            }.sortedByDescending { it.lastSeen }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun remember(host: SavedHost) {
        val next = (listOf(host) + all().filterNot { it.address == host.address && it.port == host.port })
            .take(6)
        save(next)
    }

    fun forget(address: String) {
        save(all().filterNot { it.address == address })
    }

    fun clear() = save(emptyList())

    private fun save(hosts: List<SavedHost>) {
        val array = JSONArray()
        hosts.forEach { host ->
            array.put(
                JSONObject()
                    .put("name", host.name)
                    .put("address", host.address)
                    .put("port", host.port)
                    .put("lastSeen", host.lastSeen)
            )
        }
        file.edit().putString(key, array.toString()).apply()
    }
}
