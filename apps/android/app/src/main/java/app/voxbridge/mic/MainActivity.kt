package app.voxbridge.mic

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.voxbridge.mic.data.Prefs
import app.voxbridge.mic.net.ConnectionState
import app.voxbridge.mic.net.DiscoveredHost
import app.voxbridge.mic.net.SavedHost
import app.voxbridge.mic.system.BackgroundGuard
import app.voxbridge.mic.ui.BigButton
import app.voxbridge.mic.ui.Display
import app.voxbridge.mic.ui.Divider
import app.voxbridge.mic.ui.Eyebrow
import app.voxbridge.mic.ui.KV
import app.voxbridge.mic.ui.LevelBars
import app.voxbridge.mic.ui.LocalVoxColors
import app.voxbridge.mic.ui.Mono
import app.voxbridge.mic.ui.Pill
import app.voxbridge.mic.ui.SectionLabel
import app.voxbridge.mic.ui.StatusDot
import app.voxbridge.mic.ui.VoxCard
import app.voxbridge.mic.ui.VoxTheme
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {

    private var deepLinkHost by mutableStateOf<String?>(null)
    private var deepLinkCode by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readDeepLink(intent)
        setContent {
            val app = application as VoxBridgeApp
            var theme by remember { mutableStateOf(app.prefs.theme) }
            VoxBridgeRoot(
                prefs = app.prefs,
                hostStore = app.hostStore,
                discovery = app.discovery,
                theme = theme,
                onThemeChange = {
                    theme = it
                    app.prefs.theme = it
                },
                deepLinkHost = deepLinkHost,
                deepLinkCode = deepLinkCode,
                onDeepLinkConsumed = {
                    deepLinkHost = null
                    deepLinkCode = null
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readDeepLink(intent)
    }

    private fun readDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "voxbridge") return
        deepLinkHost = data.getQueryParameter("host")
        deepLinkCode = data.getQueryParameter("code")
    }
}

private enum class Tab(val label: String) { Connect("Connect"), Studio("Studio"), Settings("Settings") }

private data class PendingConnect(val host: String, val port: Int, val code: String?, val name: String)

@Composable
private fun VoxBridgeRoot(
    prefs: Prefs,
    hostStore: app.voxbridge.mic.net.HostStore,
    discovery: app.voxbridge.mic.net.Discovery,
    theme: String,
    onThemeChange: (String) -> Unit,
    deepLinkHost: String?,
    deepLinkCode: String?,
    onDeepLinkConsumed: () -> Unit,
) {
    val context = LocalContext.current
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    val dark = when (theme) {
        "light" -> false
        "dark" -> true
        else -> systemDark
    }
    var tab by remember { mutableStateOf(Tab.Connect) }
    var pending by remember { mutableStateOf<PendingConnect?>(null) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    val tick by Session.state.collectAsState()
    val discovered by discovery.hosts.collectAsStateWithLifecycle()
    val saved by remember(tick) { mutableStateOf(hostStore.all()) }

    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            pending?.let { p -> startStream(context, prefs, p) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        pending = null
    }

    fun connect(host: String, port: Int, code: String?, name: String) {
        val request = PendingConnect(host, port, code, name)
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) startStream(context, prefs, request)
        else {
            pending = request
            micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    LaunchedEffect(Unit) {
        discovery.start(this)
    }
    LaunchedEffect(deepLinkHost) {
        if (deepLinkHost != null) {
            connect(deepLinkHost, 8720, deepLinkCode, deepLinkHost)
            onDeepLinkConsumed()
        }
    }

    VoxTheme(dark = dark) {
        val colors = LocalVoxColors.current
        Scaffold(
            containerColor = colors.paper,
            bottomBar = {
                NavigationBar(
                    containerColor = colors.panel,
                    tonalElevation = 0.dp,
                ) {
                    Tab.entries.forEach { item ->
                        NavigationBarItem(
                            selected = tab == item,
                            onClick = { tab = item },
                            icon = {
                                Icon(
                                    when (item) {
                                        Tab.Connect -> Icons.Rounded.Mic
                                        Tab.Studio -> Icons.Rounded.GraphicEq
                                        Tab.Settings -> Icons.Rounded.Settings
                                    },
                                    contentDescription = item.label,
                                )
                            },
                            label = { Text(item.label, fontSize = 11.sp) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = colors.paper,
                                selectedTextColor = colors.ink,
                                indicatorColor = colors.ink,
                                unselectedIconColor = colors.muted,
                                unselectedTextColor = colors.muted,
                            ),
                        )
                    }
                }
            },
        ) { inner ->
            Box(Modifier.fillMaxSize().padding(inner)) {
                when (tab) {
                    Tab.Connect -> ConnectScreen(
                        prefs = prefs,
                        hostStore = hostStore,
                        discovered = discovered,
                        saved = saved,
                        dark = dark,
                        onToggleTheme = { onThemeChange(if (dark) "light" else "dark") },
                        onConnect = ::connect,
                        onStop = { MicService.stop(context) },
                        onScan = {
                            discovery.stop()
                            discovery.start(scope)
                        },
                    )
                    Tab.Studio -> StudioScreen(prefs = prefs, live = Session.connection == ConnectionState.Connected)
                    Tab.Settings -> SettingsScreen(
                        prefs = prefs,
                        hostStore = hostStore,
                        theme = theme,
                        onThemeChange = onThemeChange,
                        tick = tick,
                    )
                }
            }
        }
    }
}

private fun startStream(context: Context, prefs: Prefs, request: PendingConnect) {
    if (request.code != null) prefs.lastCode = request.code
    MicService.start(context, request.host, request.port, request.code, request.name)
}

@Composable
private fun ConnectScreen(
    prefs: Prefs,
    hostStore: app.voxbridge.mic.net.HostStore,
    discovered: List<DiscoveredHost>,
    saved: List<SavedHost>,
    dark: Boolean,
    onToggleTheme: () -> Unit,
    onConnect: (String, Int, String?, String) -> Unit,
    onStop: () -> Unit,
    onScan: () -> Unit,
) {
    val colors = LocalVoxColors.current
    val context = LocalContext.current
    var manualHost by remember { mutableStateOf(prefs.lastHost ?: "") }
    var manualCode by remember { mutableStateOf(prefs.lastCode ?: "") }
    var pairing by remember { mutableStateOf<DiscoveredHost?>(null) }
    var scanning by remember { mutableStateOf(false) }
    val stats by Session.stats.collectAsState()
    val connected = Session.connection == ConnectionState.Connected
    val connecting = Session.connection == ConnectionState.Connecting
    val displayName = Session.hostName.ifBlank { Session.targetName.ifBlank { "Your PC" } }
    // Battery state is re-read on every session tick so the banner disappears
    // the moment the user comes back from the settings screen.
    val sessionTick by Session.state.collectAsState()
    var exempt by remember { mutableStateOf(BackgroundGuard.isExempt(context)) }
    LaunchedEffect(sessionTick) {
        exempt = BackgroundGuard.isExempt(context)
    }
    val retryInMs = (Session.nextRetryAt - System.currentTimeMillis()).coerceAtLeast(0)
    val retrying = Session.connection == ConnectionState.Failed && Session.nextRetryAt > 0L && retryInMs > 0L

    Box(Modifier.fillMaxSize()) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 18.dp)
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Mark(dark)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("VoxBridge", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = colors.ink)
                Mono("phone → PC microphone", size = 10)
            }
            IconButton(onClick = onToggleTheme) {
                Text(if (dark) "☀" else "☾", fontSize = 18.sp, color = colors.ink)
            }
        }

        Spacer(Modifier.height(22.dp))
        Eyebrow(
            when {
                connected -> "On air"
                connecting -> "Connecting"
                retrying -> "Reconnecting"
                else -> "Standby"
            }
        )
        Spacer(Modifier.height(6.dp))
        Display(displayName, size = 34)
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                connected -> "Every app on your PC hears this phone now. Lock the screen and put it in your pocket."
                connecting -> "Handshaking with the desktop receiver…"
                retrying -> "Wi-Fi dropped. Reconnecting in ${retryInMs / 1000 + 1}s — keep the phone where it is."
                Session.connection == ConnectionState.Failed -> Session.detail.ifBlank { "Could not reach the PC." }
                else -> "Pick the PC you want to send audio to. USB and Wi-Fi both work."
            },
            color = if (Session.connection == ConnectionState.Failed) colors.accent else colors.muted,
            fontSize = 13.sp,
            lineHeight = 19.sp,
        )

        if (!exempt && (connected || connecting)) {
            Spacer(Modifier.height(12.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(colors.panel)
                    .border(1.dp, colors.accent.copy(alpha = 0.35f), RoundedCornerShape(14.dp))
                    .clickable { BackgroundGuard.requestExemption(context) }
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Keep the mic alive when locked", color = colors.ink, fontSize = 13.sp)
                    Text(
                        "Your phone may sleep and drop the stream. Allow background running — one tap, nothing else changes.",
                        color = colors.muted, fontSize = 11.sp, lineHeight = 15.sp,
                    )
                }
                Spacer(Modifier.width(10.dp))
                Text("Allow", color = colors.accent, fontSize = 12.sp)
            }
        }

        Spacer(Modifier.height(18.dp))
        VoxCard {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(if (connected) Color(0xFF2FA36B) else if (connecting) colors.accent else colors.line)
                    Spacer(Modifier.width(8.dp))
                    Mono(
                        when {
                            connected -> "LIVE"
                            connecting -> "CONNECTING"
                            retrying -> "RETRYING"
                            Session.connection == ConnectionState.Failed -> "OFFLINE"
                            else -> "READY"
                        },
                        size = 11,
                        color = if (connected) Color(0xFF2FA36B) else colors.ink,
                    )
                    Spacer(Modifier.weight(1f))
                    Mono("${Session.rate / 1000} kHz · ${if (Session.codec == "adpcm") "ADPCM" else "PCM"}", size = 10)
                }
                Spacer(Modifier.height(14.dp))
                LevelBars(level = stats.level, peak = stats.peak, muted = Session.muted)
                Spacer(Modifier.height(12.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    MiniStat("LATENCY", if (connected) "${stats.rtt} ms" else "—")
                    MiniStat("BUFFER", if (connected) "${stats.buffer} ms" else "—")
                    MiniStat("JITTER", if (connected) "${stats.jitter} ms" else "—")
                    MiniStat("SENT", if (connected) stats.packetsSent.toString() else "—")
                }
                Spacer(Modifier.height(16.dp))
                if (connected || connecting) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        BigButton(
                            text = if (Session.muted) "Unmute" else "Mute",
                            modifier = Modifier.weight(1f),
                            accent = false,
                            onClick = {
                                Session.muted = !Session.muted
                                Session.client?.sendMute(Session.muted)
                                Session.emitState()
                            },
                        )
                        BigButton(
                            text = "Stop",
                            modifier = Modifier.weight(1f),
                            onClick = onStop,
                        )
                    }
                } else {
                    BigButton(text = "Start streaming", onClick = {
                        val host = manualHost.ifBlank { saved.firstOrNull()?.address ?: discovered.firstOrNull()?.address ?: "" }
                        if (host.isNotBlank()) {
                            onConnect(host, 8720, manualCode.ifBlank { null }, host)
                        }
                    })
                }
            }
        }

        if (discovered.isNotEmpty() || saved.isNotEmpty()) {
            Spacer(Modifier.height(22.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                SectionLabel("Nearby PCs")
                Spacer(Modifier.weight(1f))
                Text(
                    "Rescan",
                    fontSize = 12.sp,
                    color = colors.accent,
                    modifier = Modifier.clickable { onScan() },
                )
                Spacer(Modifier.width(14.dp))
            }
            VoxCard(padding = 6) {
                Column {
                    val savedOnly = saved.filter { s -> discovered.none { it.address == s.address } }
                    discovered.forEachIndexed { index, host ->
                        HostRow(host.name, "${host.address}:${host.port}", "discovered", host.needsPairing) {
                            pairing = host
                        }
                        if (index != discovered.lastIndex || savedOnly.isNotEmpty()) Divider()
                    }
                    savedOnly.forEachIndexed { index, host ->
                        HostRow(host.name, "${host.address}:${host.port}", "saved", true) {
                            onConnect(host.address, host.port, prefs.lastCode, host.name)
                        }
                        if (index != savedOnly.lastIndex) Divider()
                    }
                    if (discovered.isEmpty() && savedOnly.isEmpty()) {
                        Text(
                            "No PCs found yet. Make sure VoxBridge is open on the desktop.",
                            color = colors.muted,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(14.dp),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(22.dp))
        BigButton(text = "Scan the QR code on your PC", accent = true, onClick = { scanning = true })
        Spacer(Modifier.height(18.dp))
        SectionLabel("Connect by address")
        VoxCard {
            Column {
                OutlinedTextField(
                    value = manualHost,
                    onValueChange = { manualHost = it.trim() },
                    singleLine = true,
                    label = { Text("PC address", fontSize = 12.sp) },
                    placeholder = { Text("192.168.1.20", fontSize = 13.sp) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = manualCode,
                        onValueChange = { manualCode = it.filter(Char::isDigit).take(6) },
                        singleLine = true,
                        label = { Text("Code (optional)", fontSize = 12.sp) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(12.dp),
                    )
                    BigButton(
                        text = "Connect",
                        modifier = Modifier.weight(0.8f).padding(top = 6.dp),
                        onClick = { if (manualHost.isNotBlank()) onConnect(manualHost, 8720, manualCode.ifBlank { null }, manualHost) },
                    )
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "The 4-digit code is shown on the desktop app the first time a phone connects.",
                    color = colors.muted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                )
            }
        }

        if (discovered.isEmpty()) {
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Wifi, contentDescription = null, tint = colors.muted, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "Discovery is blocked on some Wi-Fi networks. USB tethering or a manual IP always works.",
                    color = colors.muted,
                    fontSize = 11.sp,
                    lineHeight = 16.sp,
                )
            }
        } else {
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Wifi, contentDescription = null, tint = colors.muted, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "Scanning ${discovered.size} nearby ${if (discovered.size == 1) "PC" else "PCs"} on this network.",
                    color = colors.muted,
                    fontSize = 11.sp,
                )
            }
        }
        Spacer(Modifier.height(26.dp))
    }

    if (scanning) {
        QrScannerOverlay(
            onResult = { payload ->
                scanning = false
                manualHost = payload.host
                if (payload.code != null) manualCode = payload.code
                onConnect(payload.host, payload.port, payload.code, payload.host)
            },
            onCancel = { scanning = false },
        )
    }
    }

    if (pairing != null) {
        var code by remember(pairing) { mutableStateOf(prefs.lastCode ?: "") }
        AlertDialog(
            onDismissRequest = { pairing = null },
            title = { Text("Pair with ${pairing!!.name}", fontFamily = FontFamily.Serif, fontSize = 22.sp) },
            text = {
                Column {
                    Text("Enter the 4-digit code shown on the PC.", fontSize = 13.sp, color = colors.muted)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it.filter(Char::isDigit).take(6) },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val target = pairing
                    if (target != null) {
                        onConnect(target.address, target.port, code.ifBlank { null }, target.name)
                        pairing = null
                    }
                }) { Text("Connect", color = colors.accent) }
            },
            dismissButton = {
                TextButton(onClick = { pairing = null }) { Text("Cancel", color = colors.muted) }
            },
            containerColor = colors.panel,
        )
    }
}

@Composable
private fun HostRow(name: String, address: String, tag: String, needsCode: Boolean, onClick: () -> Unit) {
    val colors = LocalVoxColors.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(colors.ink.copy(alpha = 0.06f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Rounded.Mic, contentDescription = null, tint = colors.ink, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(name, color = colors.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Mono(address, size = 10)
        }
        if (needsCode) {
            Text("4-digit code", color = colors.muted, fontSize = 10.sp)
        } else {
            Text(tag, color = colors.muted, fontSize = 10.sp)
        }
        Spacer(Modifier.width(8.dp))
        Text("→", color = colors.accent, fontSize = 16.sp)
    }
}

@Composable
private fun MiniStat(label: String, value: String) {
    val colors = LocalVoxColors.current
    Column {
        Mono(label, size = 9)
        Spacer(Modifier.height(3.dp))
        Text(value, color = colors.ink, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun Mark(dark: Boolean) {
    val colors = LocalVoxColors.current
    Row(
        Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(colors.ink),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        repeat(5) { i ->
            Box(
                Modifier
                    .padding(horizontal = 1.dp)
                    .width(2.dp)
                    .height((6 + i * 4).dp)
                    .clip(CircleShape)
                    .background(if (i == 2) colors.accent else colors.paper)
            )
        }
    }
}

@Composable
private fun StudioScreen(prefs: Prefs, live: Boolean) {
    val colors = LocalVoxColors.current
    var denoise by remember { mutableStateOf(prefs.denoise) }
    var gain by remember { mutableStateOf(prefs.inputGainDb.toFloat()) }
    var agc by remember { mutableStateOf(prefs.agc) }
    var gate by remember { mutableStateOf(prefs.gate) }
    var limiter by remember { mutableStateOf(prefs.limiter) }
    var headset by remember { mutableStateOf(prefs.headsetMic) }
    var rate by remember { mutableStateOf(prefs.rate) }
    var codec by remember { mutableStateOf(prefs.codec) }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Eyebrow("Studio")
        Spacer(Modifier.height(6.dp))
        Display("Sound, tuned.", size = 32)
        Spacer(Modifier.height(6.dp))
        Text(
            "Processing happens on the phone before a single byte is sent. Same presets as the desktop.",
            color = colors.muted, fontSize = 13.sp, lineHeight = 19.sp,
        )
        Spacer(Modifier.height(20.dp))

        SectionLabel("Noise suppression")
        VoxCard {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Off", "Low", "Mid", "High", "Max").forEachIndexed { index, label ->
                        Pill(
                            text = label,
                            selected = denoise == index,
                            modifier = Modifier.weight(1f),
                        ) {
                            denoise = index
                            prefs.denoise = index
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    "Spectral subtraction learns the room tone and removes it without hollowing out your voice.",
                    color = colors.muted, fontSize = 11.sp, lineHeight = 16.sp,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Input gain")
        VoxCard {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${gain.toInt()} dB", color = colors.ink, fontSize = 22.sp, fontFamily = FontFamily.Serif)
                    Spacer(Modifier.weight(1f))
                    Mono("range −12 … +24", size = 10)
                }
                Slider(
                    value = gain,
                    onValueChange = { gain = it },
                    onValueChangeFinished = {
                        prefs.inputGainDb = gain.toInt()
                        Session.dsp?.setGainDb(gain.toInt())
                    },
                    valueRange = -12f..24f,
                    steps = 35,
                    colors = SliderDefaults.colors(
                        thumbColor = colors.ink,
                        activeTrackColor = colors.ink,
                        inactiveTrackColor = colors.line,
                    ),
                )
                Text("Boost applies after the compressor, so quiet rooms stay quiet and close speech stays clean.",
                    color = colors.muted, fontSize = 11.sp, lineHeight = 16.sp)
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Dynamics")
        VoxCard(padding = 4) {
            Column {
                ToggleRow("Automatic gain", "Holds your voice around −19 dBFS.", agc) {
                    agc = it; prefs.agc = it
                }
                Divider()
                ToggleRow("Noise gate", "Closes the mic between phrases.", gate) {
                    gate = it; prefs.gate = it
                }
                Divider()
                ToggleRow("Safety limiter", "Prevents clipping at the desktop end.", limiter) {
                    limiter = it; prefs.limiter = it
                }
                Divider()
                ToggleRow("Headset microphone", "Uses the wired or Bluetooth headset mic.", headset) {
                    headset = it; prefs.headsetMic = it
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Transport")
        VoxCard {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(16000, 24000, 32000, 44100, 48000).forEach { option ->
                        Pill(
                            text = if (option % 1000 == 0) "${option / 1000}k" else "${option / 1000.0}k",
                            selected = rate == option,
                            modifier = Modifier.weight(1f),
                        ) {
                            rate = option
                            prefs.rate = option
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill("PCM16 · clean", selected = codec == "pcm16", modifier = Modifier.weight(1f)) {
                        codec = "pcm16"; prefs.codec = codec
                    }
                    Pill("ADPCM · 4× light", selected = codec == "adpcm", modifier = Modifier.weight(1f)) {
                        codec = "adpcm"; prefs.codec = codec
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    if (live) "Transport changes apply the next time you reconnect." else "Transport changes apply on the next connection.",
                    color = colors.muted, fontSize = 11.sp,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("On this phone")
        VoxCard {
            Text(
                "The capture service keeps the phone awake while it streams, so you can lock the screen or put the " +
                    "phone in your pocket. If your phone still sleeps, allow background running in Settings → Background.",
                color = colors.muted, fontSize = 12.sp, lineHeight = 17.sp,
            )
        }
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val colors = LocalVoxColors.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = colors.ink, fontSize = 14.sp)
            Text(subtitle, color = colors.muted, fontSize = 11.sp, lineHeight = 15.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = colors.paper,
                checkedTrackColor = colors.ink,
                uncheckedThumbColor = colors.muted,
                uncheckedTrackColor = colors.line,
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }
}

@Composable
private fun SettingsScreen(
    prefs: Prefs,
    hostStore: app.voxbridge.mic.net.HostStore,
    theme: String,
    onThemeChange: (String) -> Unit,
    tick: Int,
) {
    val colors = LocalVoxColors.current
    val context = LocalContext.current
    var remember by remember { mutableStateOf(prefs.rememberDevice) }
    var showLogs by remember { mutableStateOf(false) }
    var hosts by remember(tick) { mutableStateOf(hostStore.all()) }
    var keepAlive by remember { mutableStateOf(prefs.keepScreenOff) }
    var exempt by remember { mutableStateOf(BackgroundGuard.isExempt(context)) }
    var powerSaving by remember { mutableStateOf(BackgroundGuard.isPowerSaving(context)) }
    LaunchedEffect(tick) {
        exempt = BackgroundGuard.isExempt(context)
        powerSaving = BackgroundGuard.isPowerSaving(context)
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Eyebrow("Settings")
        Spacer(Modifier.height(6.dp))
        Display("The small print.", size = 32)
        Spacer(Modifier.height(20.dp))

        SectionLabel("Appearance")
        VoxCard {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("system" to "System", "light" to "Light", "dark" to "Dark").forEach { (key, label) ->
                    Pill(label, selected = theme == key, modifier = Modifier.weight(1f)) { onThemeChange(key) }
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Pairing")
        VoxCard(padding = 4) {
            Column {
                ToggleRow("Remember this PC", "Skips the pairing code next time.", remember) {
                    remember = it
                    prefs.rememberDevice = it
                }
                Divider()
                Row(
                    Modifier.fillMaxWidth().clickable {
                        val id = prefs.deviceId
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("VoxBridge device ID", id))
                    }.padding(horizontal = 12.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("This device", color = colors.ink, fontSize = 14.sp)
                        Mono(prefs.deviceId.take(18) + "…", size = 10)
                    }
                    Text("Copy", color = colors.accent, fontSize = 12.sp)
                }
            }
        }

        if (hosts.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            SectionLabel("Saved PCs")
            VoxCard(padding = 4) {
                Column {
                    hosts.forEachIndexed { index, host ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(host.name, color = colors.ink, fontSize = 14.sp)
                                Mono("${host.address}:${host.port}", size = 10)
                            }
                            IconButton(onClick = {
                                hostStore.forget(host.address)
                                hosts = hostStore.all()
                            }) {
                                Icon(
                                    Icons.Rounded.Close,
                                    contentDescription = "Forget ${host.name}",
                                    tint = colors.muted,
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                        if (index != hosts.lastIndex) Divider()
                    }
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Background")
        VoxCard(padding = 4) {
            Column {
                ToggleRow(
                    "Keep running when locked",
                    "Holds the CPU and Wi-Fi awake so the stream survives the lock screen.",
                    keepAlive,
                ) { on ->
                    keepAlive = on
                    prefs.keepScreenOff = on
                    MicService.applyBackgroundPolicy(context)
                }
                Divider()
                Row(
                    Modifier.fillMaxWidth().clickable { BackgroundGuard.requestExemption(context) }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Battery optimisation", color = colors.ink, fontSize = 14.sp)
                        Text(
                            if (exempt) {
                                "Unrestricted — Android will not freeze the microphone."
                            } else {
                                "Restricted — Android may pause the mic after a while. Tap to allow."
                            },
                            color = if (exempt) colors.muted else colors.accent,
                            fontSize = 11.sp,
                            lineHeight = 15.sp,
                        )
                    }
                    Text(
                        if (exempt) "Allowed" else "Allow",
                        color = if (exempt) colors.muted else colors.accent,
                        fontSize = 12.sp,
                    )
                }
                Divider()
                Row(
                    Modifier.fillMaxWidth().clickable { BackgroundGuard.openAutostart(context) }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Autostart", color = colors.ink, fontSize = 14.sp)
                        Text(
                            "Xiaomi, Huawei, Oppo, Vivo and Samsung freeze background apps until you allow them.",
                            color = colors.muted, fontSize = 11.sp, lineHeight = 15.sp,
                        )
                    }
                    Text("Open", color = colors.accent, fontSize = 12.sp)
                }
            }
        }
        if (powerSaving) {
            Spacer(Modifier.height(8.dp))
            Text(
                "Battery saver is on. It can pause Wi-Fi while the screen is off, so the phone may take a few seconds to reconnect.",
                color = colors.muted, fontSize = 11.sp, lineHeight = 15.sp,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Diagnostics")
        VoxCard {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(if (MicService.isRunning) Color(0xFF2FA36B) else colors.line)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (MicService.isRunning) "Capture service running" else "Capture service stopped",
                        color = colors.ink, fontSize = 13.sp,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        if (showLogs) "Hide" else "Show",
                        color = colors.accent, fontSize = 12.sp,
                        modifier = Modifier.clickable { showLogs = !showLogs },
                    )
                }
                if (MicService.isRunning) {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(if (Session.screenOffSafe) Color(0xFF2FA36B) else colors.line)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            if (Session.screenOffSafe) "Stays awake with the screen off" else "No background lock held",
                            color = colors.muted, fontSize = 12.sp,
                        )
                    }
                }
                if (showLogs) {
                    Spacer(Modifier.height(10.dp))
                    val lines = Session.logLines()
                    Text(
                        if (lines.isEmpty()) "No events yet." else lines.takeLast(14).joinToString("\n"),
                        color = colors.muted,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        lineHeight = 15.sp,
                    )
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("About")
        VoxCard(padding = 4) {
            Column {
                KV("Version", BuildConfig.VERSION_NAME)
                Divider()
                LinkRow("Privacy policy") { open(context, "https://voxbridge.app/privacy") }
                Divider()
                LinkRow("Setup guide") { open(context, "https://voxbridge.app/setup") }
                Divider()
                LinkRow("Source code") { open(context, "https://github.com/sdlksdsf/Virtual-Mic") }
                Divider()
                Row(
                    Modifier.fillMaxWidth().clickable {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                        context.startActivity(intent)
                    }.padding(horizontal = 12.dp, vertical = 14.dp),
                ) {
                    Text("App permissions", color = colors.ink, fontSize = 14.sp)
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Text(
            "VoxBridge 1.0.1 · made for people who sound better than their laptop mic.",
            color = colors.muted, fontSize = 11.sp, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
        )
    }
}

private fun open(context: Context, url: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    } catch (_: Exception) {
        // no browser installed
    }
}

@Composable
private fun LinkRow(label: String, onClick: () -> Unit) {
    val colors = LocalVoxColors.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = colors.ink, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text("↗", color = colors.muted, fontSize = 14.sp)
    }
}
