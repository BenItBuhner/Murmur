package app.murmur.android.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.murmur.android.keyboard.DevicePosture
import app.murmur.android.keyboard.KeyboardPresence
import app.murmur.android.keyboard.Keys
import app.murmur.android.keyboard.ShortcutCapture
import app.murmur.android.keyboard.ShortcutRecorder
import app.murmur.android.keyboard.describeAutoOverlay
import app.murmur.android.keyboard.desktopOverlayOn
import app.murmur.android.service.MurmurAccessibilityService
import app.murmur.android.settings.DesktopOverlay
import app.murmur.android.settings.HandsFreeTrigger
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.OverlayPosition
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.Cross
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.GlyphButton
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Segment
import app.murmur.android.ui.components.Segmented
import app.murmur.android.ui.components.ToggleRow
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import app.murmur.android.ui.theme.surface
import kotlinx.coroutines.delay

/**
 * The Keyboard screen: the desktop app's Shortcuts page, plus the desktop-style overlay that
 * comes with a physical keyboard. Everything here is device-local, like the desktop's shortcuts.
 */
@Composable
fun KeyboardScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val context = LocalContext.current
    val presence = remember(context) { KeyboardPresence.get(context) }
    val posture by presence.posture.collectAsState()
    val k = settings.keyboard
    val update: ((KeyboardSettings) -> KeyboardSettings) -> Unit = { change -> store.update { s -> s.copy(keyboard = change(s.keyboard)) } }

    Screen(
        title = "Keyboard",
        description = "With a keyboard attached, Murmur works the way it does on the desktop: hold a key to talk, tap it to go hands-free, hold another and say what to do with the text you selected.",
        nav = nav
    ) {
        KeyboardStatus(posture, k)

        SectionGap()

        Group("Dictation", rows = true) {
            ToggleRow(
                title = "Shortcuts",
                description = "Listen for the shortcuts below on a physical keyboard. Keys that are not part of a shortcut are never touched.",
                checked = k.shortcuts,
                onCheckedChange = { on -> update { it.copy(shortcuts = on) } }
            )
            ShortcutRow(
                title = "Push to talk",
                description = "Hold to record, release to insert. Tap it to lock hands-free (see below).",
                value = k.pushToTalk,
                sideSensitive = k.sideSensitive,
                onChange = { keys -> update { it.copy(pushToTalk = keys) } }
            )
            Column(Modifier.padding(vertical = Space.row)) {
                Text("Hands-free trigger", style = Murmur.type.title, color = Murmur.colors.ink)
                Spacer(Modifier.height(4.dp))
                Text(
                    when (k.handsFreeTrigger) {
                        HandsFreeTrigger.TAP -> "A quick tap of the push-to-talk key starts hands-free mode; press again to stop and insert."
                        HandsFreeTrigger.DOUBLE_TAP -> "Double-tap the push-to-talk key to lock hands-free. A single tap is ignored."
                        HandsFreeTrigger.OFF -> "The push-to-talk key only works while held. Use the dedicated shortcut for hands-free."
                    },
                    style = Murmur.type.bodySmall,
                    color = Murmur.colors.inkSoft
                )
                Spacer(Modifier.height(12.dp))
                Segmented(
                    options = listOf(
                        Segment(HandsFreeTrigger.TAP, "Tap"),
                        Segment(HandsFreeTrigger.DOUBLE_TAP, "Double-tap"),
                        Segment(HandsFreeTrigger.OFF, "Off")
                    ),
                    selected = k.handsFreeTrigger,
                    onSelect = { trigger -> update { it.copy(handsFreeTrigger = trigger) } }
                )
            }
            Column(Modifier.padding(vertical = Space.row)) {
                Text("Tap threshold", style = Murmur.type.title, color = Murmur.colors.ink)
                Spacer(Modifier.height(4.dp))
                Text("Presses shorter than ${k.tapThresholdMs} ms count as a tap.", style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
                val c = Murmur.colors
                Slider(
                    value = k.tapThresholdMs.toFloat(),
                    onValueChange = { v -> update { it.copy(tapThresholdMs = (v / 10f).toInt() * 10) } },
                    valueRange = 120f..800f,
                    colors = SliderDefaults.colors(
                        thumbColor = c.ink,
                        activeTrackColor = c.ink,
                        inactiveTrackColor = c.hairline,
                        activeTickColor = Color.Transparent,
                        inactiveTickColor = Color.Transparent
                    ),
                    modifier = Modifier.testTag("tapThreshold")
                )
            }
            ShortcutRow(
                title = "Hands-free shortcut",
                description = "Optional dedicated key to start or stop a hands-free session. Pressing it while holding push-to-talk locks the session.",
                value = k.handsFree,
                sideSensitive = k.sideSensitive,
                onChange = { keys -> update { it.copy(handsFree = keys) } },
                allowClear = true
            )
        }

        SectionGap()

        Group("Command mode", rows = true) {
            ShortcutRow(
                title = "Edit selection",
                description = "Select text anywhere, hold this key and say what to do: \u201cmake it shorter\u201d, \u201ctranslate to French\u201d, \u201cturn into bullet points\u201d. Needs a formatting model.",
                value = k.commandMode,
                sideSensitive = k.sideSensitive,
                onChange = { keys -> update { it.copy(commandMode = keys) } },
                allowClear = true
            )
        }

        SectionGap()

        Group("Behavior", rows = true) {
            ToggleRow(
                title = "Distinguish left and right modifiers",
                description = "When off, Right Ctrl matches a shortcut recorded with Left Ctrl. Turn on to bind e.g. Right Ctrl alone.",
                checked = k.sideSensitive,
                onCheckedChange = { on -> update { it.copy(sideSensitive = on) } }
            )
            ToggleRow(
                title = "Esc cancels",
                description = "Press Escape while listening to throw the recording away.",
                checked = k.escapeCancels,
                onCheckedChange = { on -> update { it.copy(escapeCancels = on) } }
            )
        }

        SectionGap()

        Group(
            "Overlay",
            description = "With a keyboard, the floating button gives way to the desktop's pill: a thin bar when Murmur is ready, the listening pill when it is not."
        ) {
            Segmented(
                options = listOf(Segment(DesktopOverlay.AUTO, "Auto"), Segment(DesktopOverlay.ON, "On"), Segment(DesktopOverlay.OFF, "Off")),
                selected = k.desktopOverlay,
                onSelect = { mode -> update { it.copy(desktopOverlay = mode) } }
            )
            Spacer(Modifier.height(12.dp))
            Text(
                when (k.desktopOverlay) {
                    DesktopOverlay.AUTO -> "Follows the device: a keyboard, a desktop session or a tablet-sized screen turns the pill on. ${describeAutoOverlay(posture)}"
                    DesktopOverlay.ON -> "The desktop pill, whatever is attached."
                    DesktopOverlay.OFF -> "The floating button beside the keyboard, whatever is attached."
                },
                style = Murmur.type.bodySmall,
                color = Murmur.colors.inkSoft
            )
            val desktopOn = desktopOverlayOn(k.desktopOverlay, posture)
            Spacer(Modifier.height(Space.xl))
            Column(Modifier.alpha(if (desktopOn) 1f else 0.45f)) {
                Text("Overlay position", style = Murmur.type.title, color = Murmur.colors.ink)
                Spacer(Modifier.height(4.dp))
                Text("Where the pill appears on the screen.", style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
                Spacer(Modifier.height(12.dp))
                Segmented(
                    options = OverlayPosition.entries.map { Segment(it, it.label) },
                    selected = k.overlayPosition,
                    onSelect = { position -> update { it.copy(overlayPosition = position) } }
                )
            }
            ToggleRow(
                title = "Show idle indicator",
                description = "A small bar stays visible when Murmur is ready, so you always know it is running.",
                checked = k.showOverlayWhenIdle,
                enabled = desktopOn,
                onCheckedChange = { on -> update { it.copy(showOverlayWhenIdle = on) } }
            )
            ToggleRow(
                title = "Tap the idle bar to dictate",
                description = "Off, the bar only shows that Murmur is ready: taps go to whatever is under it, and your shortcut starts a dictation. Without a keyboard attached there is no shortcut, so the bar always takes a tap.",
                checked = k.tapIdleBarToDictate,
                enabled = desktopOn && k.showOverlayWhenIdle,
                onCheckedChange = { on -> update { it.copy(tapIdleBarToDictate = on) } }
            )
        }

        Spacer(Modifier.height(Space.xl))
        Text(
            "Rules: a shortcut needs a modifier or a function key, at most three keys, and cannot mix left and right versions of the same modifier. Android's own shortcuts (Ctrl + C, Alt + Tab, Meta + L, Alt + Meta) are blocked.",
            style = Murmur.type.labelSmall,
            color = Murmur.colors.inkMuted
        )
    }
}

/** What the device is right now, and whether the service can see the keys at all. */
@Composable
private fun KeyboardStatus(posture: DevicePosture, k: KeyboardSettings) {
    val c = Murmur.colors
    val running = MurmurAccessibilityService.isRunning
    val canFilter = MurmurAccessibilityService.canFilterKeys
    Group("Right now", rows = true) {
        Row(Modifier.padding(vertical = Space.row), verticalAlignment = Alignment.CenterVertically) {
            Dot(if (posture.hardwareKeyboard) c.sage else c.inkMuted, size = 7.dp)
            Spacer(Modifier.width(12.dp))
            Column {
                Text(
                    if (posture.hardwareKeyboard) "${posture.keyboardName ?: "A keyboard"} is connected" else "No physical keyboard",
                    style = Murmur.type.title,
                    color = c.ink,
                    modifier = Modifier.testTag("keyboardStatus")
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    if (desktopOverlayOn(k.desktopOverlay, posture)) "Showing the desktop pill at ${k.overlayPosition.label.lowercase()}." else "Showing the floating button beside the keyboard.",
                    style = Murmur.type.bodySmall,
                    color = c.inkSoft
                )
            }
        }
        if (!running) {
            Notice(
                "Turn on the accessibility service under Permissions; it is what sees the keys and shows the pill.",
                NoticeTone.ERROR,
                Modifier.padding(bottom = Space.row)
            )
        } else if (!canFilter) {
            Notice(
                "Android has not yet let Murmur see hardware keys. Turn the accessibility service off and on once after this update.",
                NoticeTone.ERROR,
                Modifier.padding(bottom = Space.row)
            )
        }
    }
}

/** A row of the Dictation card: the title, the description, then the recorder on its own line. */
@Composable
private fun ShortcutRow(
    title: String,
    description: String,
    value: List<Int>,
    sideSensitive: Boolean,
    onChange: (List<Int>) -> Unit,
    allowClear: Boolean = false
) {
    Column(Modifier.padding(vertical = Space.row)) {
        Text(title, style = Murmur.type.title, color = Murmur.colors.ink)
        Spacer(Modifier.height(4.dp))
        Text(description, style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
        Spacer(Modifier.height(12.dp))
        ShortcutField(value, sideSensitive, onChange, allowClear, title)
    }
}

/**
 * The recorder: the chord as key caps in a well, a Change button, and a cross to clear it. Change
 * asks the accessibility service to capture the next chord; what it sees streams back live so the
 * caps show exactly the keys that will be matched later, and the capture ends when they are all
 * released. Esc cancels; an invalid chord shows why for a moment and keeps the old one.
 */
@Composable
fun ShortcutField(
    value: List<Int>,
    sideSensitive: Boolean,
    onChange: (List<Int>) -> Unit,
    allowClear: Boolean = false,
    name: String = "shortcut"
) {
    val c = Murmur.colors
    var session by remember { mutableStateOf<Int?>(null) }
    var live by remember { mutableStateOf<ShortcutCapture?>(null) }
    var rejected by remember { mutableStateOf<String?>(null) }
    var serviceMissing by remember { mutableStateOf(false) }
    val event by ShortcutRecorder.capture.collectAsState()
    val recording = session != null

    LaunchedEffect(event, session) {
        val current = session ?: return@LaunchedEffect
        val e = event ?: return@LaunchedEffect
        if (e.session != current) return@LaunchedEffect
        live = e.snapshot
        if (e.snapshot.final) {
            session = null
            if (e.snapshot.valid && e.snapshot.keys.isNotEmpty()) {
                onChange(e.snapshot.keys)
                live = null
            } else {
                rejected = e.snapshot.reason ?: "Not allowed"
                live = null
                delay(2500)
                rejected = null
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose { session?.let { ShortcutRecorder.stop(it) } }
    }

    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val shape = RoundedCornerShape(Radii.field)
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .background(if (recording) c.ember.copy(alpha = 0.12f) else if (rejected != null) c.clay.copy(alpha = 0.12f) else c.paperRaised, shape)
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .semantics { contentDescription = "$name: ${Keys.chordLabel(value, sideSensitive)}" },
                contentAlignment = Alignment.CenterStart
            ) {
                when {
                    recording -> {
                        val keys = live?.keys.orEmpty()
                        if (keys.isNotEmpty()) KeyCaps(keys, sideSensitive) else Pulsing { Text("Press your shortcut…", style = Murmur.type.body, color = c.inkSoft) }
                    }
                    rejected != null -> Text(rejected!!, style = Murmur.type.bodySmall, color = c.clay)
                    else -> KeyCaps(value, sideSensitive)
                }
            }
            Spacer(Modifier.width(10.dp))
            if (recording) {
                SecondaryButton("Cancel", compact = true, onClick = {
                    session?.let { ShortcutRecorder.stop(it) }
                    session = null
                    live = null
                })
            } else {
                SecondaryButton("Change", compact = true, onClick = {
                    rejected = null
                    val started = ShortcutRecorder.start()
                    serviceMissing = started == null
                    session = started
                    live = null
                })
                if (allowClear && value.isNotEmpty()) {
                    Spacer(Modifier.width(2.dp))
                    GlyphButton(
                        onClick = { onChange(emptyList()) },
                        modifier = Modifier.semantics { contentDescription = "Remove $name" }
                    ) { Cross(c.inkSoft) }
                }
            }
        }
        if (serviceMissing) {
            Spacer(Modifier.height(10.dp))
            Notice("Turn on the accessibility service under Permissions first; it is what sees the keys.", NoticeTone.ERROR)
        }
    }
}

/** A chord as key caps: small raised surfaces at the smallest radius, joined by quiet pluses. */
@Composable
fun KeyCaps(keys: List<Int>, sideSensitive: Boolean = false, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    if (keys.isEmpty()) {
        Text("Not set", style = Murmur.type.body, color = c.inkMuted, modifier = modifier)
        return
    }
    val parts = Keys.canonicalChord(keys, sideSensitive).map { Keys.keyName(it) }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        parts.forEachIndexed { i, part ->
            Box(
                Modifier
                    .surface(Elevation.raised, RoundedCornerShape(Radii.xs), color = c.card)
                    .heightIn(min = 28.dp)
                    .widthIn(min = 28.dp)
                    .padding(horizontal = 8.dp, vertical = 5.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(part, style = Murmur.type.labelSmall, color = c.ink)
            }
            if (i < parts.lastIndex) Text("+", style = Murmur.type.labelSmall, color = c.inkMuted)
        }
    }
}

@Composable
private fun Pulsing(content: @Composable () -> Unit) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val alpha by transition.animateFloat(0.45f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "alpha")
    Box(Modifier.alpha(alpha)) { content() }
}
