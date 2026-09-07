package app.murmur.android.ui

import android.content.ClipData
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.ui.components.EmphasizedAccelerate
import app.murmur.android.ui.components.EmphasizedDecelerate
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.LatencyBar
import app.murmur.android.ui.components.LazyScreen
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.entryMeta
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Entries whose text, transcript or app mention [query]; all of them for a blank query. */
fun filterHistory(entries: List<HistoryEntry>, query: String): List<HistoryEntry> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return entries
    return entries.filter {
        it.finalText.lowercase().contains(q) || it.rawText.lowercase().contains(q) ||
            (it.appName?.lowercase()?.contains(q) ?: false) || (it.error?.lowercase()?.contains(q) ?: false)
    }
}

/**
 * Every dictation made on this phone, newest first: what was inserted, and on a tap what was heard,
 * what each stage did and how long it took.
 */
@Composable
fun HistoryScreen(store: HistoryStore, nav: TopNav) {
    val c = Murmur.colors
    val entries by store.entries.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    val filtered = remember(entries, query) { filterHistory(entries, query) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()

    // A "clear all" the user walks away from is forgotten.
    LaunchedEffect(confirmClear) {
        if (confirmClear) {
            delay(5000)
            confirmClear = false
        }
    }

    LazyScreen(
        title = "History",
        description = "${pluralize(entries.size, "dictation")}, stored only on this phone.",
        nav = nav,
        trailing = {
            if (entries.isNotEmpty()) {
                AnimatedContent(
                    confirmClear,
                    transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(100)) },
                    label = "clear"
                ) { confirming ->
                    if (confirming) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextLink("Keep", onClick = { confirmClear = false })
                            TextLink("Clear ${entries.size}", color = c.clay, onClick = {
                                store.clear()
                                open = null
                                confirmClear = false
                            })
                        }
                    } else {
                        TextLink("Clear all", onClick = { confirmClear = true })
                    }
                }
            }
        },
        header = {
            if (entries.isNotEmpty()) {
                Field(value = query, onValueChange = { query = it }, placeholder = "Search dictations")
                Spacer(Modifier.height(20.dp))
                Hairline()
            }
        }
    ) {
        when {
            entries.isEmpty() -> item(key = "empty") {
                EmptyHistory(
                    "No dictations yet",
                    "Everything you dictate is listed here with what was heard, what was inserted, and how long each step took."
                )
            }
            filtered.isEmpty() -> item(key = "none") { EmptyHistory("No matches", "Try a different search.") }
            else -> items(filtered, key = { it.id }) { entry ->
                HistoryRow(
                    entry,
                    expanded = open == entry.id,
                    onToggle = { open = if (open == entry.id) null else entry.id },
                    onCopy = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Murmur", entry.finalText))) } },
                    onDelete = {
                        if (open == entry.id) open = null
                        store.delete(entry.id)
                    },
                    modifier = Modifier.animateItem(
                        fadeInSpec = tween(220),
                        placementSpec = tween(320, easing = EmphasizedDecelerate),
                        fadeOutSpec = tween(160, easing = EmphasizedAccelerate)
                    )
                )
            }
        }
    }
}

@Composable
private fun EmptyHistory(title: String, description: String) {
    val c = Murmur.colors
    Column(
        Modifier.fillMaxWidth().padding(vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(title, style = Murmur.type.displaySmall, color = c.ink)
        Spacer(Modifier.height(10.dp))
        Text(description, style = Murmur.type.bodySmall, color = c.inkSoft)
    }
}

/**
 * One dictation. Collapsed: the text and a line of facts. Expanded: the raw transcript when it
 * differs, the timing bar, the stages that touched the text, and what to do with it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HistoryRow(
    entry: HistoryEntry,
    expanded: Boolean,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    Column(modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onToggle)
                .padding(vertical = 14.dp)
        ) {
            if (entry.failed && entry.finalText.isEmpty()) {
                Text(entry.error ?: "Failed", style = Murmur.type.body, color = c.clay)
            } else {
                Text(
                    entry.finalText,
                    style = Murmur.type.body,
                    color = c.ink,
                    maxLines = if (expanded) Int.MAX_VALUE else 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Spacer(Modifier.height(6.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(entryMeta(entry), style = Murmur.type.labelSmall, color = c.inkSoft, modifier = Modifier.padding(vertical = 2.dp))
                when (entry.llm) {
                    LlmOutcome.USED -> Tag("smart")
                    LlmOutcome.REJECTED, LlmOutcome.FAILED -> Tag("rules")
                    else -> Unit
                }
                if (entry.failed && entry.finalText.isNotEmpty()) Tag("not inserted", c.clay)
            }
        }
        AnimatedVisibility(
            expanded,
            enter = fadeIn(tween(200, delayMillis = 60)) + expandVertically(tween(300, easing = EmphasizedDecelerate)),
            exit = fadeOut(tween(100)) + shrinkVertically(tween(240, easing = EmphasizedAccelerate))
        ) {
            Column(Modifier.padding(bottom = 18.dp)) {
                if (entry.rawText.isNotBlank() && entry.rawText.trim() != entry.finalText.trim()) {
                    Overline("What was heard")
                    Spacer(Modifier.height(8.dp))
                    Text(
                        entry.rawText,
                        style = Murmur.type.bodySmall,
                        color = c.inkSoft,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(c.paperRaised, RoundedCornerShape(Radii.field))
                            .border(1.dp, c.hairline, RoundedCornerShape(Radii.field))
                            .padding(horizontal = 14.dp, vertical = 12.dp)
                    )
                    Spacer(Modifier.height(18.dp))
                }
                if (!entry.failed && entry.timings.totalMs > 0) {
                    LatencyBar(entry.timings)
                    Spacer(Modifier.height(18.dp))
                }
                if (entry.stages.isNotEmpty() || entry.llm != null) {
                    Overline("Stages")
                    Spacer(Modifier.height(8.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (stage in entry.stages) Tag(stage)
                        when (entry.llm) {
                            LlmOutcome.USED -> Tag("smart formatting")
                            LlmOutcome.REJECTED -> Tag("model rejected: ${entry.llmDetail ?: "guard"}", c.clay)
                            LlmOutcome.FAILED -> Tag("model failed", c.clay)
                            LlmOutcome.SKIPPED -> entry.llmDetail?.let { Tag("model skipped: $it") }
                            null -> Unit
                        }
                    }
                    Spacer(Modifier.height(18.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        listOf(entry.provider, entry.model).filter { it.isNotBlank() }.joinToString(" · "),
                        style = Murmur.type.labelSmall,
                        color = c.inkSoft,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    if (entry.finalText.isNotEmpty()) TextLink("Copy", onClick = onCopy, color = c.ink)
                    Spacer(Modifier.width(4.dp))
                    TextLink("Delete", onClick = onDelete, color = c.clay)
                }
            }
        }
        Hairline()
    }
}

/** A small outlined label for a stage or an outcome. */
@Composable
private fun Tag(text: String, color: Color = Murmur.colors.inkSoft) {
    Text(
        text,
        style = Murmur.type.labelSmall,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .border(1.dp, if (color == Murmur.colors.inkSoft) Murmur.colors.hairline else color.copy(alpha = 0.4f), CircleShape)
            .padding(horizontal = 9.dp, vertical = 2.dp)
    )
}
