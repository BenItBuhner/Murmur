package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

enum class Route { HOME, BUTTON, MODEL, LANGUAGE, STYLE, DICTIONARY, APPEARANCE, PERMISSIONS, UPDATES, TRY_IT, ACCOUNT }

/**
 * A plain back stack held in Compose state. [NavHost] shows its top and pops it on the system back
 * gesture; the screens' own back arrows call [back].
 */
class Navigator(initial: List<Route>) {
    var stack: List<Route> by mutableStateOf(initial)
        private set

    val current: Route get() = stack.last()
    val depth: Int get() = stack.size

    /** The screen back returns to, or null at the root, where back leaves the app. */
    val previous: Route? get() = stack.getOrNull(stack.size - 2)

    fun open(route: Route) {
        if (current != route) stack = stack + route
    }

    fun back(): Boolean {
        if (stack.size <= 1) return false
        stack = stack.dropLast(1)
        return true
    }

    companion object {
        val Saver = listSaver<Navigator, String>(
            save = { it.stack.map { r -> r.name } },
            restore = { names -> Navigator(names.map { Route.valueOf(it) }.ifEmpty { listOf(Route.HOME) }) }
        )
    }
}

@Composable
fun rememberNavigator(): Navigator = rememberSaveable(saver = Navigator.Saver) { Navigator(listOf(Route.HOME)) }

/** One position in the stack: the same route at another depth is another screen. */
private data class NavEntry(val route: Route, val depth: Int)

/**
 * Shows the top of the stack. New screens slide in from the right; going back, by arrow or by the
 * system's back gesture, the screen lifts off and reveals the one below (see [BackStackHost]).
 */
@Composable
fun NavHost(navigator: Navigator, content: @Composable (Route) -> Unit) {
    BackStackHost(
        current = NavEntry(navigator.current, navigator.depth),
        previous = navigator.previous?.let { NavEntry(it, navigator.depth - 1) },
        depth = NavEntry::depth,
        onBack = { navigator.back() }
    ) { entry -> content(entry.route) }
}
