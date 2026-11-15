package app.murmur.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.murmur.android.context.ContextCapture
import app.murmur.android.ui.theme.Murmur

/** The Ephemeris ember: the warm glow behind the top of Home, and the accent of its links. */
val EmberCoral = Color(0xFFFF8A5B)
private val EmberHoney = Color(0xFFF6C27A)

/** The warm radial glow the Ephemeris Home sits on (top right, as in the desktop design). */
fun Modifier.emberGlow(): Modifier = this.background(
    Brush.radialGradient(
        0f to Color(0x66C2481F), 0.45f to Color(0x22702A14), 1f to Color.Transparent,
        center = Offset(900f, -60f), radius = 1300f
    )
)

/**
 * The Ephemeris Home's opening: the paired ember dots, then one sentence on what the phone is feeding
 * Ephemeris today, its links underlined in honey (the desktop Home's summary line).
 */
@Composable
fun EphemerisSummary(onOpenContext: () -> Unit) {
    val context = LocalContext.current
    ContextCapture.init(context)
    val on by ContextCapture.enabled.collectAsState()
    val waiting by ContextCapture.count.collectAsState()
    val c = Murmur.colors
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 6.dp).width(26.dp).height(16.dp)) {
            Box(Modifier.size(16.dp).clip(CircleShape).background(EmberHoney))
            Box(Modifier.padding(start = 10.dp).size(16.dp).clip(CircleShape).background(EmberCoral))
        }
        Spacer(Modifier.width(10.dp))
        val text = buildAnnotatedString {
            if (on) {
                append("This phone is ")
                withStyle(SpanStyle(color = EmberHoney, textDecoration = TextDecoration.Underline)) { append("keeping context") }
                append(" for Ephemeris: screen text, notifications and the app in front, never a recording. ")
                append(if (waiting == 0) "Everything is sent." else "$waiting waiting to send.")
            } else {
                append("Speak anywhere and the text lands at your cursor. ")
                withStyle(SpanStyle(color = EmberHoney, textDecoration = TextDecoration.Underline)) { append("Turn on context") }
                append(" so Ephemeris knows what was on your screen.")
            }
        }
        Text(text, style = Murmur.type.title, color = c.ink, modifier = Modifier.clickable(onClick = onOpenContext))
    }
}

/** A section title followed by the dotted rule of the desktop design ("Ongoing missions ......"). */
@Composable
fun DottedHeading(title: String, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val dot = c.inkMuted
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = Murmur.type.headline, color = c.ink)
        Spacer(Modifier.width(14.dp))
        Canvas(Modifier.weight(1f).height(4.dp)) {
            var x = 0f
            val step = 8.dp.toPx()
            while (x < size.width) { drawCircle(dot, radius = 1.2.dp.toPx(), center = Offset(x, size.height / 2)); x += step }
        }
    }
}

/** A dotted progress line, the missions' bar in the desktop design: [filled] of [total] dots lit. */
@Composable
fun EmberDotsProgress(filled: Int, total: Int, modifier: Modifier = Modifier) {
    val dim = Murmur.colors.inkMuted.copy(alpha = 0.5f)
    Canvas(modifier.fillMaxWidth().height(6.dp)) {
        val step = size.width / total
        for (i in 0 until total) {
            drawCircle(if (i < filled) EmberCoral else dim, radius = 1.6.dp.toPx(), center = Offset(step * i + step / 2, size.height / 2))
        }
    }
}

@Suppress("unused")
private val CardShape = RoundedCornerShape(16.dp)
