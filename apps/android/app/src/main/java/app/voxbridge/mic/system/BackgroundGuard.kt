package app.voxbridge.mic.system

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * The two Android settings that decide whether a locked phone keeps streaming.
 *
 * 1. Battery optimisation: Doze suspends network and CPU for apps it considers
 *    idle. A foreground service plus a wake lock covers most of it, but Doze
 *    still bites on some builds, so the app offers the exemption explicitly.
 * 2. Autostart / background activity: several OEM skins (MIUI, EMUI, ColourOS,
 *    One UI…) kill or freeze background apps regardless of what stock Android
 *    allows. Those have no public API, only vendor settings screens.
 *
 * Everything here fails soft: if a settings screen does not exist on this
 * device, the caller still lands on the app's own details page.
 */
object BackgroundGuard {

    fun isExempt(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun isPowerSaving(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return power.isPowerSaveMode
    }

    /**
     * Shows the system's "allow this app to run in the background" dialog.
     * Requires android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS; if the
     * permission is missing or the dialog is unavailable, the full battery
     * optimisation list is opened instead so the user can pick VoxBridge.
     */
    @SuppressLint("BatteryLife")
    fun requestExemption(context: Context) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
        if (launch(context, direct)) return
        if (launch(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return
        openAppDetails(context)
    }

    /** Battery usage overview, for people who prefer the long way round. */
    fun openBatterySettings(context: Context) {
        if (launch(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return
        openAppDetails(context)
    }

    /** Vendor autostart screens, newest first; the first one that resolves wins. */
    fun openAutostart(context: Context) {
        for (target in AUTOSTART) {
            val intent = Intent().setComponent(target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (launch(context, intent)) return
        }
        openAppDetails(context)
    }

    fun openAppDetails(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        launch(context, intent)
    }

    private fun launch(context: Context, intent: Intent): Boolean = try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (_: Exception) {
        // No activity on this build answers that action.
        false
    }

    private val AUTOSTART = listOf(
        // Xiaomi / Redmi / POCO
        ComponentName(
            "com.miui.securitycenter",
            "com.miui.permcenter.autostart.AutoStartManagementActivity",
        ),
        // Huawei / Honor
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
        // Oppo / Realme / OnePlus
        ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
        ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
        // Vivo / iQOO
        ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
        // Asus / Lenovo / Letv
        ComponentName("com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity"),
        ComponentName("com.lenovo.security", "com.lenovo.security.purebackground.PureBackgroundActivity"),
        ComponentName("com.letv.android.letvlive", "com.letv.android.letvlive.ui.MainActivity"),
        // Samsung
        ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
    )
}
