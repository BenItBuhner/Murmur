package app.murmur.android.keyboard

import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import app.murmur.android.settings.DesktopOverlay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Material's window width classes, from the window's width in dp. */
enum class WidthClass {
    COMPACT, MEDIUM, EXPANDED;

    companion object {
        const val MEDIUM_MIN_DP = 600
        const val EXPANDED_MIN_DP = 840

        fun of(widthDp: Int): WidthClass = when {
            widthDp >= EXPANDED_MIN_DP -> EXPANDED
            widthDp >= MEDIUM_MIN_DP -> MEDIUM
            else -> COMPACT
        }
    }
}

/** One physical keyboard the input service knows about. */
data class KeyboardDevice(val name: String, val alphabetic: Boolean, val virtual: Boolean) {
    /** A real keyboard someone can type on: not the system's virtual device, not a remote or a game pad. */
    val isHardwareKeyboard: Boolean get() = alphabetic && !virtual
}

/**
 * How the device is being used right now, as far as the overlay and the shortcuts care: is a
 * keyboard attached, how wide is the window, is this a desktop-style session (Samsung DeX, a PC).
 */
data class DevicePosture(
    val hardwareKeyboard: Boolean,
    val widthClass: WidthClass,
    val desktopSession: Boolean,
    /** The attached keyboard's name, for the settings screen; null without one. */
    val keyboardName: String? = null
) {
    /** What the automatic setting follows: a keyboard, a desktop session, or a screen as wide as a laptop's. */
    val desktopLike: Boolean get() = hardwareKeyboard || desktopSession || widthClass == WidthClass.EXPANDED

    companion object {
        /** A touch-only phone; what every code path starts from before the device has been read. */
        val PHONE = DevicePosture(hardwareKeyboard = false, widthClass = WidthClass.COMPACT, desktopSession = false)
    }
}

/** Whether the overlay takes the desktop form under [mode] on a device in [posture]. */
fun desktopOverlayOn(mode: DesktopOverlay, posture: DevicePosture): Boolean = when (mode) {
    DesktopOverlay.ON -> true
    DesktopOverlay.OFF -> false
    DesktopOverlay.AUTO -> posture.desktopLike
}

/** Why the automatic setting is on or off right now, in a sentence for the settings screen. */
fun describeAutoOverlay(posture: DevicePosture): String = when {
    posture.hardwareKeyboard -> "On right now: ${posture.keyboardName ?: "a keyboard"} is connected."
    posture.desktopSession -> "On right now: this is a desktop session."
    posture.widthClass == WidthClass.EXPANDED -> "On right now: the screen is as wide as a laptop's."
    else -> "Off right now: no keyboard is connected and the screen is phone-sized."
}

/**
 * Watches for a physical keyboard and the shape of the display. Two sources agree on the keyboard:
 * the configuration (`keyboard` is QWERTY and `hardKeyboardHidden` is NO once one is attached; the
 * system delivers a configuration change when that flips) and the input service's device list,
 * which also names the keyboard and reports attach and detach the moment they happen. Either is
 * enough to count as a keyboard; a keyboard the configuration says is hidden does not count.
 *
 * One instance per process ([get]); the accessibility service and the activity both read
 * [posture] and both call [refresh] from their own `onConfigurationChanged`.
 */
class KeyboardPresence internal constructor(
    private val app: Context,
    private val devices: () -> List<KeyboardDevice>,
    private val desktopSession: (Configuration) -> Boolean
) {
    private val _posture = MutableStateFlow(derive(app.resources.configuration))
    val posture: StateFlow<DevicePosture> = _posture

    private val listener = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) = refresh()
        override fun onInputDeviceRemoved(deviceId: Int) = refresh()
        override fun onInputDeviceChanged(deviceId: Int) = refresh()
    }

    init {
        (app.getSystemService(Context.INPUT_SERVICE) as? InputManager)
            ?.registerInputDeviceListener(listener, Handler(Looper.getMainLooper()))
    }

    /** Re-read the device; [config] is the configuration that just arrived, or the app's current one. */
    fun refresh(config: Configuration = app.resources.configuration) {
        _posture.value = derive(config)
    }

    private fun derive(config: Configuration): DevicePosture =
        derive(config, runCatching { devices() }.getOrDefault(emptyList()), runCatching { desktopSession(config) }.getOrDefault(false))

    companion object {
        @Volatile
        private var instance: KeyboardPresence? = null

        fun get(context: Context): KeyboardPresence =
            instance ?: synchronized(this) {
                instance ?: create(context.applicationContext).also { instance = it }
            }

        private fun create(app: Context): KeyboardPresence =
            KeyboardPresence(app, { listKeyboards(app) }, { config -> isDesktopSession(app, config) })

        /** The posture for a configuration and the keyboards attached. Pure, for tests. */
        fun derive(config: Configuration, devices: List<KeyboardDevice>, desktopSession: Boolean): DevicePosture {
            val hidden = config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_YES
            val configSaysKeyboard = config.keyboard == Configuration.KEYBOARD_QWERTY &&
                config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
            val keyboard = devices.firstOrNull { it.isHardwareKeyboard }
            val hardware = configSaysKeyboard || (keyboard != null && !hidden)
            return DevicePosture(
                hardwareKeyboard = hardware,
                widthClass = WidthClass.of(config.screenWidthDp),
                desktopSession = desktopSession,
                keyboardName = if (hardware) keyboard?.name?.takeIf { it.isNotBlank() } else null
            )
        }

        private fun listKeyboards(app: Context): List<KeyboardDevice> {
            val im = app.getSystemService(Context.INPUT_SERVICE) as? InputManager ?: return emptyList()
            return im.inputDeviceIds.toList().mapNotNull { id -> im.getInputDevice(id)?.toKeyboardDevice() }
        }

        private fun InputDevice.toKeyboardDevice(): KeyboardDevice = KeyboardDevice(
            name = name ?: "",
            alphabetic = (sources and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
                keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC,
            virtual = isVirtual
        )

        /**
         * Samsung DeX reports itself on the configuration through hidden fields; a Chromebook (or any
         * "PC" build) through a system feature.
         */
        private fun isDesktopSession(app: Context, config: Configuration): Boolean {
            val dex = runCatching {
                val cls = config.javaClass
                val enabled = cls.getField("SEM_DESKTOP_MODE_ENABLED").getInt(null)
                cls.getField("semDesktopModeEnabled").getInt(config) == enabled
            }.getOrDefault(false)
            if (dex) return true
            return runCatching { app.packageManager.hasSystemFeature("android.hardware.type.pc") }.getOrDefault(false)
        }
    }
}
