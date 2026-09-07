package app.murmur.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.StageTimings
import app.murmur.android.ui.formatCount
import app.murmur.android.ui.formatRelative
import app.murmur.android.ui.pluralize
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii

/*
 * The pieces the home screen is built from: stat tiles, the cards that ask for attention, a row of
 * recent history, and the bar that shows where a dictation's time went. Hairlines and paper, like
 * the rest of the app; the desktop's cards translated into Murmur's own language.
 */

/** A hairline-bordered block, the Android answer to the desktop's cards. */
@Composable
fun Tile(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = Murmur.colors
    val shape = RoundedCornerShape(Radii.block)
    Box(
        modifier
            .clip(shape)
            .border(1.dp, c.hairline, shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(18.dp)
    ) { content() }
}

/** One number worth a glance: a small glyph and label above a large serif figure. */
@Composable
fun StatTile(
    glyph: Glyph,
    label: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    value: @Composable () -> Unit
) {
    val c = Murmur.colors
    Tile(modifier) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                GlyphIcon(glyph, c.inkSoft, size = 14.dp)
                Spacer(Modifier.width(8.dp))
                Overline(label)
            }
            Spacer(Modifier.height(14.dp))
            value()
            if (hint != null) {
                Spacer(Modifier.height(4.dp))
                Text(hint, style = Murmur.type.labelSmall, color = c.inkMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The placeholder a stat shows before there is anything to count. */
@Composable
fun EmptyFigure() {
    Text("—", style = Murmur.type.numeral, color = Murmur.colors.inkMuted)
}

/**
 * Something that needs the user before dictation works (or an update waiting): a tinted card in
 * the accent with one line of why and where tapping it leads.
 */
@Composable
fun AttentionCard(title: String, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val shape = RoundedCornerShape(Radii.field + 2.dp)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.ember.copy(alpha = if (c.isDark) 0.14f else 0.09f))
            .border(1.dp, c.ember.copy(alpha = 0.35f), shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Murmur.type.title, color = c.ink)
            Spacer(Modifier.height(3.dp))
            Text(description, style = Murmur.type.bodySmall, color = c.inkSoft)
        }
        Spacer(Modifier.width(12.dp))
        Chevron(c.emberText)
    }
}

/** One recent dictation: the text, then when, where and how long. */
@Composable
fun RecentRow(entry: HistoryEntry, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val c = Murmur.colors
    Column(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(vertical = 14.dp)
    ) {
        if (entry.failed && entry.finalText.isEmpty()) {
            Text(entry.error ?: "Failed", style = Murmur.type.body, color = c.clay, maxLines = 2, overflow = TextOverflow.Ellipsis)
        } else {
            Text(entry.finalText, style = Murmur.type.body, color = c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(5.dp))
        Text(entryMeta(entry), style = Murmur.type.labelSmall, color = c.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "5 min ago · Messages · 24 words · 1,240 ms" */
fun entryMeta(entry: HistoryEntry, now: Long = System.currentTimeMillis()): String {
    val parts = ArrayList<String>(4)
    parts += formatRelative(entry.createdAt, now)
    entry.appName?.takeIf { it.isNotBlank() }?.let { parts += it }
    if (!entry.failed) parts += pluralize(entry.wordCount, "word")
    if (!entry.failed && entry.timings.totalMs > 0) parts += "${formatCount(entry.timings.totalMs.toInt())} ms"
    return parts.joinToString(" · ")
}

/** One coloured share of the latency bar. */
data class LatencyPart(val label: String, val ms: Long, val color: Color)

@Composable
fun latencyParts(t: StageTimings): List<LatencyPart> {
    val c = Murmur.colors
    val scheme = MaterialTheme.colorScheme
    return listOf(
        LatencyPart("Speech to text", t.sttMs, c.ember),
        LatencyPart("Cleanup", t.formatMs, scheme.tertiary),
        LatencyPart("Smart format", t.llmMs, scheme.secondary),
        LatencyPart("Insert", t.injectMs, c.inkMuted)
    ).filter { it.ms > 0 }
}

/**
 * Where the time went between the stop tap and the inserted text: one bar split by stage, drawn in
 * from the left the first time it appears, with a legend underneath.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LatencyBar(t: StageTimings, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val parts = latencyParts(t)
    val total = maxOf(1L, t.totalMs, parts.sumOf { it.ms })
    val drawn = rememberDrawIn()
    Column(modifier) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(CircleShape)
                .background(c.paperRaised)
                .border(1.dp, c.hairline, CircleShape)
        ) {
            var x = 0f
            val gap = 1.5.dp.toPx()
            for (part in parts) {
                val w = (size.width * (part.ms.toFloat() / total) * drawn).coerceAtLeast(0f)
                if (w > gap) drawRect(part.color, Offset(x, 0f), Size(w - gap, size.height))
                x += w
            }
        }
        Spacer(Modifier.height(12.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (part in parts) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(part.color, size = 7.dp)
                    Spacer(Modifier.width(7.dp))
                    Text(part.label, style = Murmur.type.labelSmall, color = c.inkSoft)
                    Spacer(Modifier.width(5.dp))
                    Text("${formatCount(part.ms.toInt())} ms", style = Murmur.type.labelSmall, color = c.ink)
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "Stop to inserted: ${formatCount(t.totalMs.toInt())} ms",
            style = Murmur.type.labelSmall,
            color = c.inkSoft
        )
    }
}
