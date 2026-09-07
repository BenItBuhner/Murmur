package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.mapSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

enum class Route { HOME, HISTORY, BUTTON, MODEL, LANGUAGE, STYLE, DICTIONARY, APPEARANCE, PERMISSIONS, UPDATES, TRY_IT, ACCOUNT }

/**
 * A plain back stack held in Compose state. Screens are reached two ways: [open] pushes one on top
 * (a card from the home screen, a link inside a screen), and [select] jumps to a section from the
 * drawer. Every section other than home sits on top of home, so back always leads there first and
 * leaves the app only from home, the way Material's navigation drawer behaves.
 */
class Navigator(initial: List<Route>, lateral: Boolean = false) {
    var stack: List<Route> by mutableStateOf(initial)
        private set

    /**
     * The top was reached sideways, from the drawer, rather than pushed. It decides the transition
     * (a fade-through instead of a slide) and the chrome (a menu button instead of a back arrow).
     */
    var lateral: Boolean by mutableStateOf(lateral)
        private set

    val current: Route get() = stack.last()
    val depth: Int get() = stack.size

    /** The screen back returns to, or null at the root, where back leaves the app. */
    val previous: Route? get() = stack.getOrNull(stack.size - 2)

    /** The entry on top, as the host and the chrome see it. */
    val entry: NavEntry get() = NavEntry(current, depth, lateral)

    /** Push [route] on top of the current screen. */
    fun open(route: Route) {
        if (current == route) return
        stack = stack + route
        lateral = false
    }

    /** Jump to a section from the drawer: home alone, or the section on top of home. */
    fun select(route: Route) {
        if (current == route) return
        stack = if (route == Route.HOME) listOf(Route.HOME) else listOf(Route.HOME, route)
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
     * A section the drawer leads to, or the root: it wears the menu button, and back leads home.
     * A screen pushed from another one wears a back arrow instead.
     */
    val topLevel: Boolean get() = depth == 1 || lateral
}

/**
 * Shows the top of the stack. Pushed screens slide in from the right and, going back by arrow or
 * by the system's back gesture, lift off to reveal the one below; sections chosen from the drawer
 * fade through (see [BackStackHost]).
 */
@Composable
fun NavHost(navigator: Navigator, content: @Composable (NavEntry) -> Unit) {
    BackStackHost(
        current = navigator.entry,
        previous = navigator.previous?.let { NavEntry(it, navigator.depth - 1, lateral = false) },
        depth = NavEntry::depth,
        lateral = NavEntry::lateral,
        onBack = { navigator.back() },
        content = content
    )
}
