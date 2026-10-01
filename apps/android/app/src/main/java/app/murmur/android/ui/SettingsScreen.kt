package app.murmur.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.components.Chevron
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.GlyphIcon
import app.murmur.android.ui.components.ListCard
import app.murmur.android.ui.components.ListRow
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.theme.Murmur

/**
 * The settings section: one list of every settings page, grouped, each row saying what it is set
 * to now. Tapping a row pushes the page, so back from it leads here. A list card per group, its rows
 * one radius step in (card 20 - 8 = 12), as the token system has it; the ember dots mark unfinished
 * setup and a waiting update.
 */
@Composable
fun SettingsScreen(entries: List<SettingsEntry>, nav: TopNav, onOpen: (Route) -> Unit) {
    Screen(
        title = "Settings",
        description = "How Murmur listens and types, and how the app itself behaves.",
        nav = nav
    ) {
        val groups = entries.fold(mutableListOf<MutableList<SettingsEntry>>()) { acc, entry ->
            if (entry.group != null || acc.isEmpty()) acc += mutableListOf(entry) else acc.last() += entry
            acc
        }
        groups.forEachIndexed { index, group ->
            if (index > 0) SectionGap()
            group.first().group?.let {
                Overline(it)
                Spacer(Modifier.height(10.dp))
            }
            ListCard(Modifier.testTag("settings-group-$index")) {
                for (entry in group) SettingsRow(entry, onClick = { onOpen(entry.route) })
            }
        }
    }
}

/** One page of the settings section: its glyph, its name, what it is set to, and a chevron. */
@Composable
private fun SettingsRow(entry: SettingsEntry, onClick: () -> Unit) {
    val c = Murmur.colors
    ListRow(onClick = onClick, modifier = Modifier.testTag("settings-row-${entry.route.name}")) {
        GlyphIcon(entry.glyph, c.inkSoft, size = 20.dp)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.label, style = Murmur.type.title, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!entry.value.isNullOrEmpty()) {
                Spacer(Modifier.height(2.dp))
                Text(entry.value, style = Murmur.type.bodySmall, color = c.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(12.dp))
        if (entry.attention) {
            Dot(c.ember, size = 7.dp)
            Spacer(Modifier.width(12.dp))
        }
        Chevron(c.inkMuted, size = 14.dp)
    }
}
