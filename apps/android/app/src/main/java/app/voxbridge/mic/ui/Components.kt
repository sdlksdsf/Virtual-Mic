package app.voxbridge.mic.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.max

@Composable
fun VoxCard(
    modifier: Modifier = Modifier,
    padding: Int = 18,
    content: @Composable () -> Unit,
) {
    val colors = LocalVoxColors.current
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.panel)
            .border(1.dp, colors.line, RoundedCornerShape(18.dp))
            .padding(padding.dp)
    ) { content() }
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text.uppercase(),
        modifier = modifier,
        color = LocalVoxColors.current.muted,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.6.sp,
    )
}

@Composable
fun Display(text: String, size: Int = 32, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        fontFamily = FontFamily.Serif,
        fontSize = size.sp,
        lineHeight = (size * 1.02).sp,
        fontWeight = FontWeight.Normal,
        letterSpacing = (-0.5).sp,
        color = LocalVoxColors.current.ink,
    )
}

@Composable
fun Mono(text: String, size: Int = 12, color: Color = LocalVoxColors.current.muted, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        fontFamily = FontFamily.Monospace,
        fontSize = size.sp,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
fun Pill(
    text: String,
    selected: Boolean = false,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalVoxColors.current
    val bg = if (selected) colors.ink else Color.Transparent
    val fg = if (selected) colors.paper else colors.ink
    Box(
        modifier
            .clip(CircleShape)
            .background(bg)
            .border(1.dp, if (selected) colors.ink else colors.line, CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = if (enabled) fg else colors.muted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
fun BigButton(
    text: String,
    modifier: Modifier = Modifier,
    accent: Boolean = true,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalVoxColors.current
    val bg = when {
        !enabled -> colors.line
        accent -> colors.accent
        else -> Color.Transparent
    }
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(bg)
            .border(1.dp, if (accent) bg else colors.line, RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 15.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = if (accent) Color.White else colors.ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.2.sp,
        )
    }
}

private const val BARS = 28

/** Live input level. Pure canvas, no animation clock: redrawn on state change. */
@Composable
fun LevelBars(level: Float, peak: Float, muted: Boolean, modifier: Modifier = Modifier) {
    val colors = LocalVoxColors.current
    val slot = 1f / BARS
    Canvas(modifier.fillMaxWidth().height(64.dp)) {
        val barWidth = size.width / BARS * 0.55f
        val gap = size.width / BARS
        val base = size.height
        for (i in 0 until BARS) {
            val t = i.toFloat() / (BARS - 1)
            // A gentle bell shape keeps the meter readable at low levels.
            val shape = 0.35f + 0.65f * kotlin.math.sin(Math.PI * t).toFloat()
            val energy = if (muted) 0f else max(0f, level * 3.2f * (0.4f + shape))
            val h = (energy.coerceIn(0f, 1f) * (base - 6f)) + 3f
            val x = i * gap + (gap - barWidth) / 2f
            val active = (abs(peak) > 0.004f) && !muted
            val color = when {
                !active -> colors.line.copy(alpha = 0.7f)
                i > BARS * 0.86 -> colors.accent
                else -> colors.ink.copy(alpha = 0.22f + 0.78f * (i / BARS.toFloat()))
            }
            drawRoundRect(
                color = color,
                topLeft = Offset(x, base - h),
                size = Size(barWidth, h),
                cornerRadius = CornerRadius(barWidth / 2f, barWidth / 2f),
            )
        }
    }
}

@Composable
fun StatusDot(color: Color?) {
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color ?: LocalVoxColors.current.line)
    )
}

@Composable
fun Divider() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(LocalVoxColors.current.line)
    )
}

@Composable
fun KV(label: String, value: String, highlight: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 7.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = LocalVoxColors.current.muted, fontSize = 13.sp)
        Mono(
            value,
            size = 12,
            color = if (highlight) LocalVoxColors.current.accent else LocalVoxColors.current.ink,
        )
    }
}

@Composable
fun SectionLabel(text: String) {
    Spacer(Modifier.height(6.dp))
    Text(
        text.uppercase(),
        color = LocalVoxColors.current.muted,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 1.4.sp,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
    )
}
