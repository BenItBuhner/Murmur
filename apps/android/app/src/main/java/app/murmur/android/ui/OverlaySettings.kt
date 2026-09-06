package app.murmur.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.theme.MurmurTheme
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * "Dictation button" settings: its resting shape, a live preview of every state, and where it
 * sits relative to the keyboard (drag it into place on screen).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DictationButtonSection(store: SettingsStore, settings: MurmurSettings) {
    val context = LocalContext.current
    val palette = PillTheme.resolve(context, settings)
    val editing by OverlayEditor.editing.collectAsState()
    var previewState by remember { mutableStateOf<DictationState>(DictationState.Idle) }
    var playing by remember { mutableStateOf(false) }
    var editError by remember { mutableStateOf<String?>(null) }
    var keepOpen by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Shape", Modifier.padding(end = 12.dp), fontSize = 13.sp, color = Muted)
        for ((shape, label) in listOf(OverlayShape.PILL to "Pill", OverlayShape.CIRCLE to "Circle")) {
            FilterChip(
                selected = settings.overlayShape == shape,
                onClick = { store.update { s -> s.copy(overlayShape = shape) } },
                label = { Text(label) },
                modifier = Modifier.padding(end = 6.dp)
            )
        }
    }
    Text(
        if (settings.overlayShape == OverlayShape.CIRCLE)
            "A compact circle: small enough to sit on your keyboard's toolbar without covering anything."
        else
            "The classic pill. Switch to Circle for a smaller button you can tuck into the keyboard's toolbar.",
        fontSize = 12.sp, color = Muted
    )

    // The pill floats over keyboards, so preview it on the palette's deepest surface.
    Box(
        Modifier
            .fillMaxWidth()
            .height(72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
    ) {
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
    }
    Text(
        if (playing) "Listening → transcribing → formatting → inserted."
        else "Tap the preview to watch it morph through a dictation.",
        fontSize = 12.sp, color = Muted
    )
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

    Text("Position", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
    Text(describePosition(settings), fontSize = 12.sp, color = Muted)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (editing) {
            Button(onClick = { OverlayEditor.stop() }) { Text("Done") }
        } else {
            Button(
                onClick = {
                    editError = if (OverlayEditor.start()) null
                    else "Turn on the accessibility service under Setup first; it draws the button."
                }
            ) { Text("Edit position") }
        }
        OutlinedButton(
            onClick = {
                store.update {
                    it.copy(overlayAnchorX = OverlayAnchor.DEFAULT.xFraction, overlayOffsetDp = OverlayAnchor.DEFAULT.offsetDp)
                }
            },
            enabled = !settings.overlayAtDefaultPosition
        ) { Text("Reset") }
    }
    editError?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
    if (editing) {
        Text(
            "Drag the button anywhere on screen (it snaps to the middle) — onto your keyboard's toolbar, for example. " +
                "It follows the keyboard wherever it appears. Tap Done at the top of the screen when it is in place.",
            fontSize = 12.sp, color = MurmurTheme.colors.success
        )
        OutlinedTextField(
            value = keepOpen,
            onValueChange = { keepOpen = it },
            label = { Text("This field keeps your keyboard open") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().focusRequester(focusRequester)
        )
        LaunchedEffect(Unit) {
            delay(60)
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
}

private fun describePosition(s: MurmurSettings): String {
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
