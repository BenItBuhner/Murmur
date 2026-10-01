package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.mapSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

/**
 * Every screen in the app. Five of them are sections the drawer leads to (home, history, the
 * dictionary, style, settings); the account is reached from the drawer's foot; the rest are
 * pages of the settings section, listed on the Settings screen and reached from there.
 */
enum class Route {
    HOME, HISTORY, BUTTON, KEYBOARD, MODEL, LANGUAGE, STYLE, DICTIONARY, APPEARANCE, PERMISSIONS, UPDATES, TRY_IT, ACCOUNT, SETTINGS;

    /** A page of the settings section rather than a section of its own. */
    val inSettings: Boolean
        get() = when (this) {
            MODEL, LANGUAGE, BUTTON, KEYBOARD, APPEARANCE, PERMISSIONS, UPDATES, TRY_IT -> true
            else -> false
        }

    /** The section this screen belongs to: itself, or [SETTINGS] for one of its pages. */
    val section: Route get() = if (inSettings) SETTINGS else this

    /** A destination of its own (the drawer's items and the account), as opposed to a settings page. */
    val isSection: Boolean get() = !inSettings
}

/**
 * A plain back stack held in Compose state. Screens are reached two ways: [open] pushes one on top
 * (a card from the home screen, a row on the Settings screen), and [select] jumps to a section from
 * the drawer. Every section other than home sits on top of home, so back always leads there first
 * and leaves the app only from home, the way Material's navigation drawer behaves. A settings page
 * selected directly (the pill's "own model" chip) sits on top of Settings, so back leads there.
 */
class Navigator(initial: List<Route>, lateral: Boolean = false) {
    var stack: List<Route> by mutableStateOf(initial)
        private set

    /**
     * The top was reached sideways, from the drawer, rather than pushed. It decides the transition
     * (a fade-through instead of a slide).
     */
    var lateral: Boolean by mutableStateOf(lateral)
        private set

    val current: Route get() = stack.last()
    val depth: Int get() = stack.size

    /** The screen back returns to, or null at the root, where back leaves the app. */
    val previous: Route? get() = stack.getOrNull(stack.size - 2)

    /** The drawer item that stands for what is on screen: Settings while one of its pages is up. */
    val section: Route get() = current.section

    /** The entry on top, as the host and the chrome see it. */
    val entry: NavEntry get() = NavEntry(current, depth, lateral)

    /** Push [route] on top of the current screen. */
    fun open(route: Route) {
        if (current == route) return
        stack = stack + route
        lateral = false
    }

    /** Jump to a section from the drawer: home alone, a section on top of home, a settings page on top of Settings. */
    fun select(route: Route) {
        if (current == route) return
        stack = when {
            route == Route.HOME -> listOf(Route.HOME)
            route.inSettings -> listOf(Route.HOME, Route.SETTINGS, route)
            else -> listOf(Route.HOME, route)
        }
        lateral = true
    }

    fun back(): Boolean {
        if (stack.size <= 1) return false
        stack = stack.dropLast(1)
        lateral = false
        return true
    }

    companion object {
        val Saver = mapSaver(
            save = { mapOf(STACK to it.stack.map { r -> r.name }, LATERAL to it.lateral) },
            restore = { saved ->
                @Suppress("UNCHECKED_CAST")
                val names = (saved[STACK] as? List<String>).orEmpty()
                val routes = names.mapNotNull { name -> Route.entries.firstOrNull { it.name == name } }
                Navigator(routes.ifEmpty { listOf(Route.HOME) }, saved[LATERAL] as? Boolean ?: false)
            }
        )
        private const val STACK = "stack"
        private const val LATERAL = "lateral"
    }
}

@Composable
fun rememberNavigator(): Navigator = rememberSaveable(saver = Navigator.Saver) { Navigator(listOf(Route.HOME)) }

/** One position in the stack: the same route at another depth, or reached another way, is another screen. */
data class NavEntry(val route: Route, val depth: Int, val lateral: Boolean) {
    /**
     * The root, or a section resting directly on it: it wears the menu button, and back leads home.
     * Anything deeper (a settings page, a screen pushed from another one) wears a back arrow instead.
     */
    val topLevel: Boolean get() = depth == 1 || (depth == 2 && route.isSection)

    /**
     * What the host keeps this screen's state under: the same screen at the same depth keeps its
     * state however it was reached, so a section comes back as it was left after a push and a back.
     */
    val key: String get() = "${route.name}/$depth"
}

/**
 * Shows the top of the stack. Pushed screens slide in from the right and, going back by arrow or
 * by the system's back gesture, slide out the way the finger moves to reveal the one below;
 * sections chosen from the drawer fade through (see [BackStackHost]).
 */
@Composable
fun NavHost(navigator: Navigator, backEnabled: Boolean = true, content: @Composable (NavEntry) -> Unit) {
    BackStackHost(
        current = navigator.entry,
        previous = navigator.previous?.let { NavEntry(it, navigator.depth - 1, lateral = false) },
        depth = NavEntry::depth,
        key = NavEntry::key,
        lateral = NavEntry::lateral,
        backEnabled = backEnabled,
        onBack = { navigator.back() },
        content = content
    )
}
