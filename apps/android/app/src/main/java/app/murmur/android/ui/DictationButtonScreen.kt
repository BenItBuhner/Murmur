package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayEditor
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
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

@Composable
fun DictationButtonScreen(store: SettingsStore, settings: MurmurSettings, onBack: () -> Unit) {
    val editing by OverlayEditor.editing.collectAsState()
    var editError by remember { mutableStateOf<String?>(null) }
    var keepOpen by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    Screen(
        title = "Dictation button",
        description = "The button that appears beside your keyboard. Choose how it rests and where it sits.",
        onBack = onBack
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

        Group("Position") {
            Spacer(Modifier.height(8.dp))
            Text(describePosition(settings), style = Murmur.type.body, color = Murmur.colors.ink)
            Spacer(Modifier.height(18.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (editing) {
                    PrimaryButton("Done", onClick = { OverlayEditor.stop() }, modifier = Modifier.weight(1f))
                } else {
                    PrimaryButton(
                        "Move the button",
                        modifier = Modifier.weight(1f),
                        onClick = {
                            editError = if (OverlayEditor.start()) null
                            else "Turn on the accessibility service under Permissions first; it is what draws the button."
                        }
                    )
                }
                SecondaryButton(
                    "Reset",
                    enabled = !settings.overlayAtDefaultPosition,
                    onClick = {
                        store.update {
                            it.copy(overlayAnchorX = OverlayAnchor.DEFAULT.xFraction, overlayOffsetDp = OverlayAnchor.DEFAULT.offsetDp)
                        }
                    }
                )
            }
            editError?.let {
                Spacer(Modifier.height(14.dp))
                Notice(it, NoticeTone.ERROR)
            }
            if (editing) {
                Spacer(Modifier.height(18.dp))
                Notice(
                    "Drag the button anywhere; it snaps to the middle. Park it on your keyboard's toolbar if you like. " +
                        "It follows the keyboard wherever it appears. Tap Done at the top of the screen when it is in place.",
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

/**
 * The real overlay view in preview mode on a dark stage. Tap it and it plays a whole dictation:
 * listening, transcribing, formatting, inserted.
 */
@Composable
fun PillPreview(settings: MurmurSettings, height: Dp, modifier: Modifier = Modifier) {
    var previewState by remember { mutableStateOf<DictationState>(DictationState.Idle) }
    var playing by remember { mutableStateOf(false) }
    // The same colours the accessibility service gives the real button.
    val palette = PillTheme.resolve(LocalContext.current, settings)

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
                view.configure(settings.overlayShape, OverlayAnchor.DEFAULT)
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

fun describePosition(s: MurmurSettings): String {
    val across = when {
        abs(s.overlayAnchorX - 0.5f) < 0.015f -> "Centred"
        s.overlayAnchorX < 0.5f -> "${(s.overlayAnchorX * 100).roundToInt()}% in from the left"
        else -> "${((1f - s.overlayAnchorX) * 100).roundToInt()}% in from the right"
    }
    val offset = s.overlayOffsetDp.roundToInt()
    val vertical = when {
        offset > 0 -> "floating $offset dp above the keyboard"
        offset == 0 -> "on the keyboard's top edge"
        else -> "${-offset} dp down over the keyboard"
    }
    return "$across, $vertical."
}

/** Short form for the home index. */
fun shortPosition(s: MurmurSettings): String {
    val shape = if (s.overlayShape == OverlayShape.CIRCLE) "Circle" else "Pill"
    val where = when {
        s.overlayAtDefaultPosition -> "centred above the keyboard"
        abs(s.overlayAnchorX - 0.5f) < 0.015f -> "centred, custom height"
        s.overlayAnchorX < 0.5f -> "left of centre"
        else -> "right of centre"
    }
    return "$shape, $where"
}
