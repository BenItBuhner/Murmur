package app.murmur.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

enum class Route { HOME, BUTTON, MODEL, LANGUAGE, STYLE, DICTIONARY, APPEARANCE, PERMISSIONS, UPDATES, TRY_IT, ACCOUNT }

/** A plain back stack held in Compose state; the system back gesture pops it. */
class Navigator(initial: List<Route>) {
    var stack: List<Route> by mutableStateOf(initial)
        private set

    val current: Route get() = stack.last()
    val depth: Int get() = stack.size

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
fun rememberNavigator(): Navigator {
    val navigator = rememberSaveable(saver = Navigator.Saver) { Navigator(listOf(Route.HOME)) }
    BackHandler(enabled = navigator.depth > 1) { navigator.back() }
    return navigator
}

/** Slides new screens in from the right and slides them back out on the way home. */
@Composable
fun NavHost(navigator: Navigator, content: @Composable (Route) -> Unit) {
    val spec = tween<Float>(300, easing = FastOutSlowInEasing)
    AnimatedContent(
        targetState = navigator.current to navigator.depth,
        transitionSpec = {
            val forward = targetState.second >= initialState.second
            (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { if (forward) it / 5 else -it / 5 } + fadeIn(spec))
                .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { if (forward) -it / 5 else it / 5 } + fadeOut(spec))
        },
        label = "route"
    ) { (route, _) -> content(route) }
}
