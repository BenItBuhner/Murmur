package app.murmur.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.BuildConfig
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.history.HistoryStore
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.components.Appear
import app.murmur.android.ui.components.AttentionCard
import app.murmur.android.ui.components.CountUp
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.EmptyFigure
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.components.Hairline
import app.murmur.android.ui.components.LatencyBar
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.RecentRow
import app.murmur.android.ui.components.Reveal
import app.murmur.android.ui.components.RollingText
import app.murmur.android.ui.components.StatTile
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase

/** How many recent dictations the home screen lists before pointing at History. */
private const val RECENT = 5

/**
 * The dashboard: a greeting, whatever still needs attention, the numbers (words, pace, time saved,
 * streak), a few things worth knowing, the live button, the latest dictations and where their time
 * went. The sections themselves live in the drawer behind the button at the top left.
 */
@Composable
fun HomeScreen(
    config: CloudConfig,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?,
    nav: TopNav,
    onOpen: (Route) -> Unit
) {
    val c = Murmur.colors
    val context = LocalContext.current
    val permissions = rememberPermissionState()
    val dictation by DictationController.state.collectAsState()
    val updateState by UpdateManager.get(context).state.collectAsState()
    val history by HistoryStore.get(context).entries.collectAsState()
    val modelReady = settings.speechModelConfigured
    val ready = permissions.allGranted && modelReady
    val greeting = remember { greetingFor() }
    // Signed in, the account's totals stand for every device; otherwise this phone's own.
    val stats = if (signedIn) syncStatus?.stats ?: settings.stats else settings.stats
    val recent = remember(history) { history.take(RECENT) }
    val last = remember(history) { lastSuccessful(history) }
    val insights = remember(history) { insightLines(history, daySummary(history, DictationStats.localDay(System.currentTimeMillis()))) }
    val updateReady = updateState.phase == UpdatePhase.READY

    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PageMargin - 10.dp).height(64.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TopNavButton(nav)
            Spacer(Modifier.width(6.dp))
            Wordmark()
            Spacer(Modifier.weight(1f))
            StatusLine(dictation, ready, onClick = { onOpen(if (!permissions.allGranted) Route.PERMISSIONS else Route.MODEL) })
        }

        Column(Modifier.padding(horizontal = PageMargin)) {
            Reveal(0) {
                Column {
                    Spacer(Modifier.height(16.dp))
                    Text(
                        "$greeting${firstName?.let { ", $it" } ?: ""}.",
                        style = Murmur.type.displayMedium,
                        color = c.ink
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "Tap the button beside your keyboard, speak, and finished text lands where your cursor is.",
                        style = Murmur.type.body,
                        color = c.inkSoft
                    )
                    Spacer(Modifier.height(24.dp))
                }
            }

            Appear(!modelReady) {
                Column {
                    AttentionCard(
                        "Connect a speech model",
                        "Murmur needs a transcription endpoint: OpenAI, Groq, Deepgram, or a local whisper server.",
                        onClick = { onOpen(Route.MODEL) }
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }
            Appear(!permissions.allGranted) {
                Column {
                    AttentionCard(
                        if (permissions.total - permissions.granted == 1) "One permission to go" else "${permissions.total - permissions.granted} permissions to go",
                        "The microphone, drawing the button and typing for you each need a system grant.",
                        onClick = { onOpen(Route.PERMISSIONS) }
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }
            Appear(updateReady) {
                Column {
                    AttentionCard(
                        "Version ${updateState.release?.version ?: ""} is ready".trim(),
                        "Downloaded and checked; it installs the next time nothing is being dictated.",
                        onClick = { onOpen(Route.UPDATES) }
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }

            Reveal(1) {
                Column {
                    Spacer(Modifier.height(12.dp))
                    StatsGrid(stats)
                }
            }

            Appear(insights.isNotEmpty()) {
                Column {
                    Spacer(Modifier.height(28.dp))
                    Overline("Worth knowing")
                    Spacer(Modifier.height(6.dp))
                    Hairline()
                    for (line in insights) {
                        Text(line, style = Murmur.type.body, color = c.ink, modifier = Modifier.padding(vertical = 13.dp))
                        Hairline()
                    }
                }
            }

            Reveal(2) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Overline("Your button")
                        Spacer(Modifier.weight(1f))
                        TextLink("Adjust", onClick = { onOpen(Route.BUTTON) })
                    }
                    Spacer(Modifier.height(10.dp))
                    PillPreview(settings, height = 128.dp)
                }
            }

            Reveal(3) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Overline("Recent")
                        Spacer(Modifier.weight(1f))
                        if (history.isNotEmpty()) TextLink("View all", onClick = { onOpen(Route.HISTORY) })
                    }
                    Spacer(Modifier.height(6.dp))
                    Hairline()
                    if (recent.isEmpty()) {
                        EmptyRecent(onTry = { onOpen(Route.TRY_IT) })
                    } else {
                        for (entry in recent) {
                            RecentRow(entry, onClick = { onOpen(Route.HISTORY) })
                            Hairline()
                        }
                    }
                }
            }

            Appear(last != null) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Overline("Last dictation, where the time went")
                    Spacer(Modifier.height(14.dp))
                    last?.let { LatencyBar(it.timings) }
                }
            }

            Spacer(Modifier.height(44.dp))
            Text("Murmur ${BuildConfig.VERSION_NAME}", style = Murmur.type.labelSmall, color = c.inkMuted)
            Spacer(Modifier.height(28.dp))
        }
    }
}

/** Words, pace, time saved and streak, two by two, counting up as they arrive. */
@Composable
private fun StatsGrid(stats: DictationStats) {
    val wpm = wordsPerMinute(stats)
    val savedSec = (timeSavedMs(stats) / 1000).toInt()
    // Tiles in a row share the taller one's height, so a wrapped label never leaves a step.
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val tile = Modifier.weight(1f).fillMaxHeight()
            StatTile(Glyph.WORDS, "Words dictated", tile, hint = if (stats.isEmpty) "Nothing yet" else pluralize(stats.totalSessions, "dictation")) {
                CountUp(stats.totalWords, format = ::formatCount)
            }
            StatTile(Glyph.PACE, "Speaking pace", tile, hint = if (wpm > 0) "vs ~$TYPING_WPM typing" else null) {
                if (wpm > 0) CountUp(wpm, format = { "$it wpm" }) else EmptyFigure()
            }
        }
        Row(Modifier.height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val tile = Modifier.weight(1f).fillMaxHeight()
            StatTile(Glyph.TIME, "Time saved", tile, hint = if (savedSec > 0) "over typing it out" else null) {
                if (savedSec > 0) CountUp(savedSec, format = { formatDurationShort(it * 1000L) }) else EmptyFigure()
            }
            StatTile(Glyph.STREAK, "Day streak", tile, hint = if (stats.streakDays > 0) "dictated every day" else null) {
                if (stats.streakDays > 0) CountUp(stats.streakDays) else EmptyFigure()
            }
        }
    }
}

@Composable
private fun EmptyRecent(onTry: () -> Unit) {
    val c = Murmur.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            "Nothing yet. Your dictations show up here with their timing breakdown.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
        Spacer(Modifier.height(8.dp))
        TextLink("Try it now", onClick = onTry, color = c.ink)
    }
}

/** Live state in the corner: what the button is doing right now, or that setup is unfinished. */
@Composable
private fun StatusLine(state: DictationState, ready: Boolean, onClick: () -> Unit) {
    val c = Murmur.colors
    val (label, target, pulsing) = when {
        state is DictationState.Listening -> Triple("Listening", c.ember, true)
        state is DictationState.Processing -> Triple("Working", c.ember, true)
        !ready -> Triple("Setup", c.ember, false)
        else -> Triple("Ready", c.sage, false)
    }
    val color by animateColorAsState(target, tween(260), label = "status")
    Row(
        Modifier
            .clip(CircleShape)
            .clickable(enabled = !ready, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Dot(color, size = 7.dp, pulsing = pulsing)
        Spacer(Modifier.width(9.dp))
        RollingText(label.uppercase(), style = Murmur.type.overline, color = if (ready) c.inkSoft else c.ink)
    }
}
