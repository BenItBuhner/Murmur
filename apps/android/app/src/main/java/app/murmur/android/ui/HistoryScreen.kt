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
import androidx.compose.foundation.shape.RoundedCornerShape
import android.media.MediaPlayer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.RecordingStore
import app.murmur.android.history.RecordingsInfo
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.EmphasizedAccelerate
import app.murmur.android.ui.components.EmphasizedDecelerate
import app.murmur.android.ui.components.Card
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.LatencyBar
import app.murmur.android.ui.components.LazyScreen
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.RowCardPadding
import app.murmur.android.ui.components.Tag
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.components.Well
import app.murmur.android.ui.components.entryMeta
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import app.murmur.android.ui.theme.surface
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

/** "12 MB", "820 KB", "1.2 GB": how much the recordings take. */
fun formatBytes(bytes: Long): String {
    if (bytes < 1024L * 1024) return "${maxOf(1L, bytes / 1024)} KB"
    val mb = bytes / (1024.0 * 1024)
    return if (mb < 1024) (if (mb < 10) "%.1f MB".format(mb) else "%.0f MB".format(mb)) else "%.2f GB".format(mb / 1024)
}

/**
 * Every dictation made on this phone, newest first: what was inserted, and on a tap what was heard,
 * what each stage did and how long it took. Recordings play back from here, and a dictation that
 * failed can be sent again.
 */
@Composable
fun HistoryScreen(store: HistoryStore, settings: SettingsStore, recordings: RecordingStore, nav: TopNav) {
    val c = Murmur.colors
    val context = LocalContext.current
    val entries by store.entries.collectAsState()
    val prefs by settings.flow.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    var confirmClearRecordings by remember { mutableStateOf(false) }
    val filtered = remember(entries, query) { filterHistory(entries, query) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val recordingsInfo = remember(entries) { recordings.info() }

    // Sending a recording again: which entry, and what came of asking (until the pipeline answers).
    var retrying by remember { mutableStateOf<String?>(null) }
    var retryNote by remember { mutableStateOf<Pair<String, String>?>(null) }
    val dictation by DictationController.state.collectAsState()
    LaunchedEffect(dictation, retrying) {
        val id = retrying ?: return@LaunchedEffect
        when (val s = dictation) {
            is DictationState.Processing -> Unit
            is DictationState.Error -> {
                retryNote = id to s.message
                retrying = null
            }
            else -> retrying = null
        }
    }

    // Playback of a stored recording; one at a time, released with the screen.
    var playing by remember { mutableStateOf<String?>(null) }
    val player = remember { mutableStateOf<MediaPlayer?>(null) }
    fun stopPlayback() {
        player.value?.let { runCatching { it.stop() }; it.release() }
        player.value = null
        playing = null
    }
    fun togglePlay(entry: HistoryEntry) {
        if (playing == entry.id) {
            stopPlayback()
            return
        }
        stopPlayback()
        val name = entry.recording ?: return
        if (!recordings.has(name)) return
        try {
            val mp = MediaPlayer()
            mp.setDataSource(recordings.file(name).path)
            mp.setOnCompletionListener { if (player.value === mp) stopPlayback() }
            mp.setOnErrorListener { _, _, _ -> if (player.value === mp) stopPlayback(); true }
            mp.prepare()
            mp.start()
            player.value = mp
            playing = entry.id
        } catch (_: Exception) {
            stopPlayback()
        }
    }
    DisposableEffect(Unit) { onDispose { stopPlayback() } }

    // A "clear all" the user walks away from is forgotten.
    LaunchedEffect(confirmClear) {
        if (confirmClear) {
            delay(5000)
            confirmClear = false
        }
    }
    LaunchedEffect(confirmClearRecordings) {
        if (confirmClearRecordings) {
            delay(5000)
            confirmClearRecordings = false
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
            RecordingsRow(
                keep = prefs.keepRecordings,
                onKeepChange = { keep -> settings.update { it.copy(keepRecordings = keep) } },
                info = recordingsInfo,
                confirming = confirmClearRecordings,
                onConfirmChange = { confirmClearRecordings = it },
                onClear = {
                    stopPlayback()
                    store.stripRecordings()
                    recordings.clear()
                    confirmClearRecordings = false
                }
            )
            if (entries.isNotEmpty()) {
                Spacer(Modifier.height(20.dp))
                Field(value = query, onValueChange = { query = it }, placeholder = "Search dictations")
                Spacer(Modifier.height(20.dp))
            }
        }
    ) {
        when {
            entries.isEmpty() -> item(key = "empty") {
                EmptyHistory(
                    "No dictations yet",
                    "Everything you dictate is listed here with what was heard, what was inserted, the recording, and how long each step took. A dictation that failed can be sent again from here."
                )
            }
            filtered.isEmpty() -> item(key = "none") { EmptyHistory("No matches", "Try a different search.") }
            else -> items(filtered, key = { it.id }) { entry ->
                HistoryRow(
                    entry,
                    expanded = open == entry.id,
                    playing = playing == entry.id,
                    retrying = retrying == entry.id,
                    retryNote = retryNote?.takeIf { it.first == entry.id }?.second,
                    onToggle = { open = if (open == entry.id) null else entry.id },
                    onCopy = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Murmur", entry.finalText))) } },
                    onPlay = { togglePlay(entry) },
                    onRetry = {
                        retryNote = null
                        // From here the focused field would be Murmur's own: the text is copied instead.
                        val refused = DictationController.retry(context, entry.id, insert = false)
                        if (refused == null) retrying = entry.id else retryNote = entry.id to refused
                    },
                    onDelete = {
                        if (open == entry.id) open = null
                        if (playing == entry.id) stopPlayback()
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

/** The "Keep recordings" switch with how much the recordings take and a way to delete them all: one card. */
@Composable
private fun RecordingsRow(
    keep: Boolean,
    onKeepChange: (Boolean) -> Unit,
    info: RecordingsInfo,
    confirming: Boolean,
    onConfirmChange: (Boolean) -> Unit,
    onClear: () -> Unit
) {
    val c = Murmur.colors
    Card(padding = RowCardPadding) {
        ToggleRow(
            title = "Keep recordings",
            description = "Store the audio of every dictation with its entry, to play it back or send it again. Off, only failed dictations keep their audio until they succeed. Recordings never leave this phone.",
            checked = keep,
            onCheckedChange = onKeepChange
        )
        Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (info.count == 0) "No recordings stored"
                else "${pluralize(info.count, "recording")}, ${formatBytes(info.bytes)}",
                style = Murmur.type.labelSmall,
                color = c.inkSoft,
                modifier = Modifier.weight(1f)
            )
            if (info.count > 0) {
                AnimatedContent(
                    confirming,
                    transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(100)) },
                    label = "clear-recordings"
                ) { asking ->
                    if (asking) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextLink("Keep", onClick = { onConfirmChange(false) })
                            TextLink("Delete ${info.count}", color = c.clay, onClick = onClear)
                        }
                    } else {
                        TextLink("Delete all", onClick = { onConfirmChange(true) })
                    }
                }
            }
        }
    }
}

/** Nothing to list: a well where the entries will be. */
@Composable
private fun EmptyHistory(title: String, description: String) {
    val c = Murmur.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radii.card))
            .background(c.paperRaised)
            .padding(horizontal = Space.card, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(title, style = Murmur.type.displaySmall, color = c.ink)
        Spacer(Modifier.height(10.dp))
        Text(description, style = Murmur.type.bodySmall, color = c.inkSoft)
    }
}

/**
 * One dictation, a card of its own. Collapsed: the text and a line of facts. Expanded: the raw
 * transcript when it differs, the timing bar, the stages that touched the text, and what to do
 * with it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HistoryRow(
    entry: HistoryEntry,
    expanded: Boolean,
    playing: Boolean,
    retrying: Boolean,
    /** Why the last retry from here did not work out, shown under the entry. */
    retryNote: String?,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
    onPlay: () -> Unit,
    onRetry: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    val shape = RoundedCornerShape(Radii.card)
    Column(
        modifier
            .fillMaxWidth()
            .padding(bottom = Space.sm)
            .surface(if (expanded) Elevation.floating else Elevation.raised, shape)
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button, onClick = onToggle)
                .padding(horizontal = Space.card, vertical = Space.card)
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                FlowRow(
                    Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(entryMeta(entry), style = Murmur.type.labelSmall, color = c.inkSoft, modifier = Modifier.padding(vertical = 2.dp))
                    when (entry.llm) {
                        LlmOutcome.USED -> Tag("smart")
                        LlmOutcome.REJECTED, LlmOutcome.FAILED -> Tag("rules")
                        else -> Unit
                    }
                    if (entry.failed && entry.finalText.isNotEmpty()) Tag("not inserted", c.clay)
                    if (entry.attempts > 1) Tag("attempt ${entry.attempts}")
                }
                // Right in the row, so a failed dictation is one tap from being sent again.
                if (entry.retryable) {
                    Spacer(Modifier.width(8.dp))
                    if (retrying) {
                        Text("Sending again…", style = Murmur.type.label, color = c.inkSoft)
                    } else {
                        TextLink("Retry", onClick = onRetry, color = c.ink)
                    }
                }
            }
            if (retryNote != null) {
                Spacer(Modifier.height(4.dp))
                Text(retryNote, style = Murmur.type.labelSmall, color = c.clay)
            }
        }
        AnimatedVisibility(
            expanded,
            enter = fadeIn(tween(200, delayMillis = 60)) + expandVertically(tween(300, easing = EmphasizedDecelerate)),
            exit = fadeOut(tween(100)) + shrinkVertically(tween(240, easing = EmphasizedAccelerate))
        ) {
            Column(Modifier.padding(start = Space.card, end = Space.card, bottom = Space.card)) {
                if (entry.rawText.isNotBlank() && entry.rawText.trim() != entry.finalText.trim()) {
                    Overline("What was heard")
                    Spacer(Modifier.height(8.dp))
                    Well { Text(entry.rawText, style = Murmur.type.bodySmall, color = c.inkSoft) }
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
                    if (entry.recording != null) TextLink(if (playing) "Stop" else "Play", onClick = onPlay, color = c.ink)
                    if (entry.finalText.isNotEmpty()) TextLink("Copy", onClick = onCopy, color = c.ink)
                    Spacer(Modifier.width(4.dp))
                    TextLink("Delete", onClick = onDelete, color = c.clay)
                }
            }
        }
    }
}
