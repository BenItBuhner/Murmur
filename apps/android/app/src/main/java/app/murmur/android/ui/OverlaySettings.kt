package app.murmur.android.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayArrangement
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.SettingsStore
import kotlinx.coroutines.delay
import kotlin.math.sin

private val Muted = Color(0xFF9A9AA2)

/**
 * "Dictation button" settings: its resting shape, a live preview of every state, and the spots it
 * can be parked on near the keyboard (edited by dragging on screen).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DictationButtonSection(store: SettingsStore, settings: MurmurSettings) {
    val editing by OverlayEditor.editing.collectAsState()
    var previewState by remember { mutableStateOf<DictationState>(DictationState.Idle) }
    var playing by remember { mutableStateOf(false) }
    var editError by remember { mutableStateOf<String?>(null) }
    var keepOpen by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val layout = settings.overlayLayout

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

    Box(
        Modifier
            .fillMaxWidth()
            .height(72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF0B0B0D))
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
                view.configure(settings.overlayShape, OverlayLayout.DEFAULT)
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

    Text("Spots", fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
    Text(
        "The button rests on one of its spots. When it is in the way (a suggestion, a key), drag it " +
            "and let go: it snaps to the nearest spot, so it is always somewhere you chose.",
        fontSize = 12.sp, color = Muted
    )
    SpotMap(layout, settings.overlayShape)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((i, spot) in layout.spots.withIndex()) {
            val active = i == layout.activeIndex
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier
                        .size(18.dp)
                        .clip(CircleShape)
                        .background(if (active) Accent else Color(0xFF3C3C45)),
                    contentAlignment = Alignment.Center
                ) {
                    Text((i + 1).toString(), fontSize = 10.sp, fontWeight = FontWeight.Bold, color = Color.White)
                }
                Text(spot.describe(), fontSize = 12.sp, color = if (active) Color.White else Muted)
                if (active) Text("resting here", fontSize = 11.sp, color = Accent)
            }
        }
    }
    Text(describeArrangement(layout), fontSize = 12.sp, color = Muted)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (editing) {
            Button(onClick = { OverlayEditor.stop() }, colors = ButtonDefaults.buttonColors(containerColor = Accent)) { Text("Done") }
        } else {
            Button(
                onClick = {
                    editError = if (OverlayEditor.start()) null
                    else "Turn on the accessibility service under Setup first; it draws the button."
                },
                colors = ButtonDefaults.buttonColors(containerColor = Accent)
            ) { Text("Edit spots") }
        }
        OutlinedButton(
            onClick = { store.update { it.copy(overlayLayout = OverlayLayout.DEFAULT) } },
            enabled = !layout.isDefault
        ) { Text("Reset") }
    }
    editError?.let { Text(it, fontSize = 12.sp, color = Color(0xFFE08A8A)) }
    if (editing) {
        Text(
            "Drag a spot anywhere on screen; it snaps to the middle and to the other spots' rows and columns " +
                "(a guide line shows when it does). Use the arrows to nudge it a dp at a time, + to add up to " +
                "${OverlayLayout.MAX_SPOTS} spots, and Same row or Same column to keep them lined up. " +
                "Tap Done at the top when you are happy.",
            fontSize = 12.sp, color = Color(0xFFB8E0C2)
        )
        OutlinedTextField(
            value = keepOpen,
            onValueChange = { keepOpen = it },
            label = { Text("This field keeps your keyboard open") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            colors = fieldColors()
        )
        LaunchedEffect(Unit) {
            delay(60)
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
}

/** Half-scale sketch of the bottom of the screen with the keyboard, showing where the spots sit. */
@Composable
private fun SpotMap(layout: OverlayLayout, shape: OverlayShape) {
    val textMeasurer = rememberTextMeasurer()
    val badgeStyle = TextStyle(color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    Box(
        Modifier
            .fillMaxWidth()
            .height(112.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF0B0B0D)),
        contentAlignment = Alignment.Center
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val scale = 0.5f * density
            val phoneW = 360f * scale
            val phoneH = 224f * scale
            val left = (size.width - phoneW) / 2f
            val top = size.height - phoneH
            val keyboardH = 150f * scale
            val keyboardTop = top + phoneH - keyboardH
            val corner = CornerRadius(18f * scale)

            // Screen, keyboard, its toolbar row and the keyboard's top edge (the line offsets are measured from).
            drawRoundRect(Color(0xFF16161A), Offset(left, top), Size(phoneW, phoneH + corner.y), corner)
            drawRect(Color(0xFF1E1E24), Offset(left, keyboardTop), Size(phoneW, keyboardH))
            drawRect(Color(0xFF26262D), Offset(left, keyboardTop), Size(phoneW, 40f * scale))
            for (row in 0 until 3) {
                val y = keyboardTop + (52f + row * 34f) * scale
                for (col in 0 until 10) {
                    val x = left + (10f + col * 34f) * scale
                    drawRoundRect(Color(0xFF32323A), Offset(x, y), Size(30f * scale, 26f * scale), CornerRadius(4f * scale))
                }
            }
            drawLine(Color(0x55FFFFFF), Offset(left, keyboardTop), Offset(left + phoneW, keyboardTop), strokeWidth = 1.dp.toPx())

            val margin = OverlayGeometry.EDGE_MARGIN_DP * scale
            val w = (if (shape == OverlayShape.CIRCLE) 36f else 64f) * scale
            val h = 36f * scale
            for ((i, spot) in layout.spots.withIndex()) {
                val cx = left + OverlayGeometry.clampCenter(spot.xFraction * phoneW, w, phoneW, margin)
                val cy = top + OverlayGeometry.clampCenter(keyboardTop - top - spot.offsetDp * scale, h, phoneH, margin)
                val active = i == layout.activeIndex
                val r = CornerRadius(h / 2f)
                drawRoundRect(if (active) Color(0xFF141414) else Color(0x66141414), Offset(cx - w / 2f, cy - h / 2f), Size(w, h), r)
                drawRoundRect(
                    if (active) Accent else Color(0x99FFFFFF),
                    Offset(cx - w / 2f, cy - h / 2f),
                    Size(w, h),
                    r,
                    style = Stroke(
                        width = if (active) 1.5.dp.toPx() else 1.dp.toPx(),
                        pathEffect = if (active) null else PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))
                    )
                )
                val label = textMeasurer.measure((i + 1).toString(), badgeStyle)
                drawText(label, topLeft = Offset(cx - label.size.width / 2f, cy - label.size.height / 2f))
            }
        }
    }
}

private fun describeArrangement(layout: OverlayLayout): String {
    val count = if (layout.spots.size == 1) "One spot" else "${layout.spots.size} spots"
    return when (layout.arrangement) {
        OverlayArrangement.SAME_ROW -> "$count, locked to one row (drag any of them up or down and they all follow)."
        OverlayArrangement.SAME_COLUMN -> "$count, locked to one column (drag any of them sideways and they all follow)."
        OverlayArrangement.FREE -> if (layout.spots.size == 1) "$count. Add another to flick the button out of the way." else "$count, placed freely."
    }
}
