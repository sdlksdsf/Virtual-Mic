package app.voxbridge.mic.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val Ink = Color(0xFF15150F)
private val Paper = Color(0xFFF4F1EA)
private val Panel = Color(0xFFFBF9F4)
private val Line = Color(0xFFDCD6C8)
private val Accent = Color(0xFFFF5A2E)
private val DarkBg = Color(0xFF0E0E0A)
private val DarkPanel = Color(0xFF17170F)
private val DarkLine = Color(0xFF2C2C23)
private val MutedLight = Color(0xFF6F6A5E)
private val MutedDark = Color(0xFF9C968A)

private val LightScheme = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFE2D8),
    onPrimaryContainer = Color(0xFF54180A),
    secondary = Ink,
    onSecondary = Paper,
    secondaryContainer = Color(0xFFE7E1D4),
    onSecondaryContainer = Ink,
    background = Paper,
    onBackground = Ink,
    surface = Panel,
    onSurface = Ink,
    surfaceVariant = Color(0xFFEDE8DD),
    onSurfaceVariant = MutedLight,
    outline = Line,
    outlineVariant = Color(0xFFE6E0D3),
    error = Color(0xFFB3261E),
)

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF160B07),
    primaryContainer = Color(0xFF4A1B0F),
    onPrimaryContainer = Color(0xFFFFD9CD),
    secondary = Paper,
    onSecondary = Ink,
    secondaryContainer = Color(0xFF26261D),
    onSecondaryContainer = Paper,
    background = DarkBg,
    onBackground = Paper,
    surface = DarkPanel,
    onSurface = Paper,
    surfaceVariant = Color(0xFF22221A),
    onSurfaceVariant = MutedDark,
    outline = DarkLine,
    outlineVariant = Color(0xFF26261D),
    error = Color(0xFFFFB4AB),
)

data class VoxColors(
    val accent: Color,
    val line: Color,
    val muted: Color,
    val panel: Color,
    val onPanel: Color,
    val paper: Color,
    val ink: Color,
)

val LocalVoxColors = staticCompositionLocalOf {
    VoxColors(Accent, Line, MutedLight, Panel, Ink, Paper, Ink)
}

@Composable
fun VoxTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = VoxColors(
        accent = Accent,
        line = if (dark) DarkLine else Line,
        muted = if (dark) MutedDark else MutedLight,
        panel = if (dark) DarkPanel else Panel,
        onPanel = if (dark) Paper else Ink,
        paper = if (dark) DarkBg else Paper,
        ink = if (dark) Paper else Ink,
    )
    CompositionLocalProvider(LocalVoxColors provides colors) {
        MaterialTheme(
            colorScheme = if (dark) DarkScheme else LightScheme,
            content = content,
        )
    }
}
