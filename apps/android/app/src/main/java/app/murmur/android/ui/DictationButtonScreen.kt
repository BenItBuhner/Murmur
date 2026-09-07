package app.murmur.android.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayArrangement
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Segment
import app.murmur.android.ui.components.Segmented
import app.murmur.android.ui.components.Stage
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.delay
import kotlin.math.sin

@Composable
fun DictationButtonScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val editing by OverlayEditor.editing.collectAsState()
    var editError by remember { mutableStateOf<String?>(null) }
    var keepOpen by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val layout = settings.overlayLayout

    Screen(
        title = "Dictation button",
        description = "The button that appears beside your keyboard. Choose how it rests and where it sits.",
        nav = nav
    ) {
        PillPreview(settings, height = 136.dp)

        SectionGap()

        Group("Shape") {
            Spacer(Modifier.height(8.dp))
            Segmented(
                options = listOf(Segment(OverlayShape.PILL, "Pill"), Segment(OverlayShape.CIRCLE, "Circle")),
                selected = settings.overlayShape,
                onSelect = { shape -> store.update { s -> s.copy(overlayShape = shape) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                if (settings.overlayShape == OverlayShape.CIRCLE) {
                    "A compact circle, small enough to sit on your keyboard's own toolbar without covering anything."
                } else {
                    "The classic pill. Choose Circle for a smaller button you can tuck into the keyboard's toolbar."
                },
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
        }

        SectionGap()

        Group("Spots") {
            Spacer(Modifier.height(8.dp))
            Text(
                "The button rests on one of its spots. When it is in the way — a suggestion, a key — " +
                    "drag it and let go: it snaps to the nearest spot, so it is always somewhere you chose.",
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
            Spacer(Modifier.height(14.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                layout.spots.forEachIndexed { i, spot ->
                    SpotRow(index = i, spot = spot.describe(), active = i == layout.activeIndex)
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(describeArrangement(layout), style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (editing) {
                    PrimaryButton("Done", onClick = { OverlayEditor.stop() }, modifier = Modifier.weight(1f))
                } else {
                    PrimaryButton(
                        "Edit spots",
                        modifier = Modifier.weight(1f),
                        onClick = {
                            editError = if (OverlayEditor.start()) null
                            else "Turn on the accessibility service under Permissions first; it is what draws the button."
                        }
                    )
                }
                SecondaryButton(
                    "Reset",
                    enabled = !layout.isDefault,
                    onClick = { store.update { it.copy(overlayLayout = OverlayLayout.DEFAULT) } }
                )
            }
            editError?.let {
                Spacer(Modifier.height(14.dp))
                Notice(it, NoticeTone.ERROR)
            }
            if (editing) {
                Spacer(Modifier.height(18.dp))
                Notice(
                    "Drag a spot anywhere; it snaps to the middle and to the other spots' rows and columns, " +
                        "with a guide line when it lines up. Use the arrows to nudge it a dp at a time, + to add " +
                        "up to ${OverlayLayout.MAX_SPOTS} spots, and Same row or Same column to keep them aligned. " +
                        "Tap Done at the top of the screen when you are happy.",
                    NoticeTone.SUCCESS
                )
                Spacer(Modifier.height(18.dp))
                Field(
                    value = keepOpen,
                    onValueChange = { keepOpen = it },
                    label = "Keeps your keyboard open",
                    placeholder = "Type nothing; this just holds the keyboard up",
                    focusRequester = focusRequester
                )
                LaunchedEffect(Unit) {
                    delay(60)
                    focusRequester.requestFocus()
                    keyboard?.show()
                }
            }
        }
    }
}

/** One spot in the list: a numbered dot (filled when it is where the button rests) and its position. */
@Composable
private fun SpotRow(index: Int, spot: String, active: Boolean) {
    val c = Murmur.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier.size(22.dp).clip(CircleShape).background(if (active) c.ember else c.paperRaised),
            contentAlignment = Alignment.Center
        ) {
            Text("${index + 1}", style = Murmur.type.labelSmall, color = if (active) c.onEmber else c.inkSoft)
        }
        Text(spot, style = Murmur.type.body, color = if (active) c.ink else c.inkSoft)
        if (active) Text("rests here", style = Murmur.type.labelSmall, color = c.emberText)
    }
}

/**
 * The real overlay view in preview mode on a keyboard-like stage, in the same colours the
 * accessibility service gives the real button. Tap it and it plays a whole dictation: listening,
 * transcribing, formatting, inserted.
 */
@Composable
fun PillPreview(settings: MurmurSettings, height: Dp, modifier: Modifier = Modifier) {
    var previewState by remember { mutableStateOf<DictationState>(DictationState.Idle) }
    var playing by remember { mutableStateOf(false) }
    // The same colours the accessibility service gives the real button; a dark-mode flip or a new
    // wallpaper arrives as a configuration change.
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val palette = remember(settings.themeMode, settings.dynamicColor, settings.accent, configuration) {
        PillTheme.resolve(context, settings)
    }

    Stage(modifier.height(height)) {
        AndroidView(
            factory = { ctx ->
                OverlayPillView(ctx).apply {
                    previewMode = true
                    onMicTap = { playing = true }
                    onConfirmTap = { playing = false }
                }
            },
            modifier = Modifier.fillMaxSize(),
            update = { view ->
                view.setPalette(palette)
                view.configure(settings.overlayShape, OverlayLayout.DEFAULT)
                view.render(previewState)
            }
        )
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp)) {
            Text(
                if (playing) "Listening, transcribing, formatting, inserted" else "Tap the button to watch a dictation",
                style = Murmur.type.labelSmall,
                color = Murmur.colors.onStage.copy(alpha = 0.55f)
            )
        }
    }

    LaunchedEffect(playing) {
        if (!playing) {
            previewState = DictationState.Idle
            return@LaunchedEffect
        }
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < 2600) {
            val t = (System.currentTimeMillis() - start) / 1000f
            val level = (0.42f + 0.28f * sin(t * 7.3f) + 0.22f * sin(t * 13.1f)).coerceIn(0.1f, 1f)
            previewState = DictationState.Listening(t.toInt(), level)
            delay(80)
        }
        previewState = DictationState.Processing("Transcribing…")
        delay(1300)
        previewState = DictationState.Processing("Formatting…")
        delay(900)
        previewState = DictationState.Success("Inserted")
        delay(1400)
        previewState = DictationState.Idle
        playing = false
    }
}

private fun describeArrangement(layout: OverlayLayout): String {
    val count = if (layout.spots.size == 1) "One spot" else "${layout.spots.size} spots"
    return when (layout.arrangement) {
        OverlayArrangement.SAME_ROW -> "$count, locked to one row — drag any of them up or down and they all follow."
        OverlayArrangement.SAME_COLUMN -> "$count, locked to one column — drag any of them sideways and they all follow."
        OverlayArrangement.FREE ->
            if (layout.spots.size == 1) "$count. Add another so you can flick the button out of the way." else "$count, placed freely."
    }
}

fun describePosition(s: MurmurSettings): String {
    val layout = s.overlayLayout
    val here = layout.active.describe()
    return if (layout.spots.size == 1) "$here." else "$here, and ${layout.spots.size - 1} more."
}

/** Short form for the home index. */
fun shortPosition(s: MurmurSettings): String {
    val shape = if (s.overlayShape == OverlayShape.CIRCLE) "Circle" else "Pill"
    val spots = s.overlayLayout.spots.size
    val where = if (spots == 1) "one spot" else "$spots spots"
    return "$shape, $where"
}
