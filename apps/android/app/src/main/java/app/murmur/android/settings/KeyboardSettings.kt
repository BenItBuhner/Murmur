package app.murmur.android.settings

import app.murmur.android.keyboard.Key
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** What a quick tap of the push-to-talk shortcut does (desktop: `handsFreeTriggerSchema`). */
enum class HandsFreeTrigger(val id: String) {
    TAP("tap"),
    DOUBLE_TAP("double-tap"),
    OFF("off");

    companion object {
        fun from(id: String?): HandsFreeTrigger = entries.firstOrNull { it.id == id } ?: TAP
    }
}

/**
 * Whether the overlay takes the desktop app's form (a pill parked at a fixed position, an idle bar,
 * shortcuts) instead of the floating button beside the keyboard. AUTO follows the device: a
 * physical keyboard, a tablet-sized screen or a desktop-style session (Samsung DeX, desktop
 * windowing) turns it on; a touch-only phone keeps the button.
 */
enum class DesktopOverlay(val id: String) {
    AUTO("auto"),
    ON("on"),
    OFF("off");

    companion object {
        fun from(id: String?): DesktopOverlay = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** Where the desktop-style pill sits; the desktop app's `overlayPositionSchema`, same ids. */
enum class OverlayPosition(val id: String, val label: String) {
    BOTTOM_CENTER("bottom-center", "Bottom center"),
    TOP_CENTER("top-center", "Top center"),
    BOTTOM_RIGHT("bottom-right", "Bottom right");

    companion object {
        fun from(id: String?): OverlayPosition = entries.firstOrNull { it.id == id } ?: BOTTOM_CENTER
    }
}

/**
 * Everything about using Murmur with a physical keyboard, kept as one section of the settings so it
 * can be stored and edited as a unit. The shortcut fields mirror the desktop `hotkeys` schema
 * (same names, same key codes, same defaults where Android allows them; see
 * [app.murmur.android.keyboard.Keys]) and the overlay fields the desktop `general.overlayPosition`
 * and `general.showOverlayWhenIdle`. Device-local; never synced, as on the desktop.
 */
data class KeyboardSettings(
    /** Listen for the shortcuts at all. Off, hardware keys are never filtered. */
    val shortcuts: Boolean = true,
    /** Hold to record, release to insert; a quick tap locks hands-free. Ctrl + Meta, as on the desktop. */
    val pushToTalk: List<Int> = DEFAULT_PUSH_TO_TALK,
    /** Starts or stops a hands-free session on its own. Ctrl + Meta + Space, as on the desktop. */
    val handsFree: List<Int> = DEFAULT_HANDS_FREE,
    /**
     * Hold and say what to do with the selected text. The desktop's Alt + Meta toggles Caps Lock on
     * Android, so the default here is Shift + Meta: Meta plus a neighbouring modifier, like the rest.
     */
    val commandMode: List<Int> = DEFAULT_COMMAND_MODE,
    val handsFreeTrigger: HandsFreeTrigger = HandsFreeTrigger.TAP,
    val tapThresholdMs: Int = 350,
    val doubleTapWindowMs: Int = 400,
    val sideSensitive: Boolean = false,
    val escapeCancels: Boolean = true,
    val desktopOverlay: DesktopOverlay = DesktopOverlay.AUTO,
    val overlayPosition: OverlayPosition = OverlayPosition.BOTTOM_CENTER,
    /** A small bar stays visible when Murmur is ready, as on the desktop. */
    val showOverlayWhenIdle: Boolean = true
) {
    companion object {
        val DEFAULT_PUSH_TO_TALK: List<Int> = listOf(Key.CTRL, Key.META)
        val DEFAULT_HANDS_FREE: List<Int> = listOf(Key.CTRL, Key.META, Key.SPACE)
        val DEFAULT_COMMAND_MODE: List<Int> = listOf(Key.SHIFT, Key.META)
        val DEFAULT = KeyboardSettings()
    }
}

/** Persists a [KeyboardSettings] as one JSON string, tolerating anything an older or newer build wrote. */
object KeyboardSettingsCodec {
    @Serializable
    private data class Stored(
        val shortcuts: Boolean = true,
        val pushToTalk: List<Int> = KeyboardSettings.DEFAULT_PUSH_TO_TALK,
        val handsFree: List<Int> = KeyboardSettings.DEFAULT_HANDS_FREE,
        val commandMode: List<Int> = KeyboardSettings.DEFAULT_COMMAND_MODE,
        val handsFreeTrigger: String = HandsFreeTrigger.TAP.id,
        val tapThresholdMs: Int = 350,
        val doubleTapWindowMs: Int = 400,
        val sideSensitive: Boolean = false,
        val escapeCancels: Boolean = true,
        val desktopOverlay: String = DesktopOverlay.AUTO.id,
        val overlayPosition: String = OverlayPosition.BOTTOM_CENTER.id,
        val showOverlayWhenIdle: Boolean = true
    )

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(s: KeyboardSettings): String = json.encodeToString(
        Stored(
            shortcuts = s.shortcuts,
            pushToTalk = s.pushToTalk,
            handsFree = s.handsFree,
            commandMode = s.commandMode,
            handsFreeTrigger = s.handsFreeTrigger.id,
            tapThresholdMs = s.tapThresholdMs,
            doubleTapWindowMs = s.doubleTapWindowMs,
            sideSensitive = s.sideSensitive,
            escapeCancels = s.escapeCancels,
            desktopOverlay = s.desktopOverlay.id,
            overlayPosition = s.overlayPosition.id,
            showOverlayWhenIdle = s.showOverlayWhenIdle
        )
    )

    /** The stored section, or the defaults when nothing usable was stored. */
    fun decode(raw: String?): KeyboardSettings {
        if (raw.isNullOrBlank()) return KeyboardSettings.DEFAULT
        val parsed = try {
            json.decodeFromString<Stored>(raw)
        } catch (_: Exception) {
            return KeyboardSettings.DEFAULT
        }
        return KeyboardSettings(
            shortcuts = parsed.shortcuts,
            pushToTalk = parsed.pushToTalk.take(3),
            handsFree = parsed.handsFree.take(3),
            commandMode = parsed.commandMode.take(3),
            handsFreeTrigger = HandsFreeTrigger.from(parsed.handsFreeTrigger),
            tapThresholdMs = parsed.tapThresholdMs.coerceIn(80, 1500),
            doubleTapWindowMs = parsed.doubleTapWindowMs.coerceIn(100, 1500),
            sideSensitive = parsed.sideSensitive,
            escapeCancels = parsed.escapeCancels,
            desktopOverlay = DesktopOverlay.from(parsed.desktopOverlay),
            overlayPosition = OverlayPosition.from(parsed.overlayPosition),
            showOverlayWhenIdle = parsed.showOverlayWhenIdle
        )
    }
}
