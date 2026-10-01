package app.murmur.android.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Shows the top of a back stack and animates every change to it, including the Android 14+
 * predictive back gesture, with one transform that is seeked by the finger and finished (or
 * rewound) on release. Ported from Cursor for Android's navigation host.
 *
 * At most two entries are on screen: the resident one and, during a transition, the one beneath
 * it. A single `progress` (0 = the top screen is at rest, 1 = it is gone) drives both: the top
 * screen rounds its corners and slides in the direction of the swipe until it is entirely off
 * screen, while the screen underneath fades in and drifts into place behind it. Neither changes
 * size. Pushes play the same transform backwards, so forward and back share one vocabulary.
 * Because the gesture's [BackEventCompat] is read here, the direction follows the edge the swipe
 * came from. The card travels on the x-axis only: the finger's height never moves it.
 *
 * Moving sideways between sections (a drawer choice) is neither forward nor back: an entry marked
 * [lateral] fades in where it stands as the screen it covers fades out, neither moving.
 *
 * At the root ([previous] is null) back is left to the system, which animates the whole app away.
 *
 * @param current the entry on top.
 * @param previous the entry a back gesture reveals; null at the root.
 * @param depth deeper entries sit on top of shallower ones, and moving deeper is forward.
 * @param key what an entry's saved state is kept under; it must be storable in a Bundle.
 * @param lateral entries reached sideways, which fade through instead of sliding.
 * @param backEnabled whether back belongs to the stack at all (the drawer takes it while open).
 * @param onBack pops the stack; called once a back gesture or press has been committed.
 */
@Composable
fun <T : Any> BackStackHost(
    current: T,
    previous: T?,
    depth: (T) -> Int,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    key: (T) -> String = { it.toString() },
    lateral: (T) -> Boolean = { false },
    backEnabled: Boolean = true,
    content: @Composable (T) -> Unit
) {
    val scene = remember { BackScene(current) }
    val stateHolder = rememberSaveableStateHolder()
    val scope = rememberCoroutineScope()
    // Read when a pane is disposed, which can be long after it was composed.
    val latestCurrent by rememberUpdatedState(current)
    val latestPrevious by rememberUpdatedState(previous)

    LaunchedEffect(current) {
        try {
            scene.moveTo(current, deeper = depth(current) > depth(scene.top), glide = lateral(current))
        } catch (_: CancellationException) {
            // Superseded: a gesture took over the animation, or the stack changed again.
        }
    }

    PredictiveBackHandler(enabled = backEnabled && previous != null) { events ->
        val under = previous
        if (under == null) {
            // The stack emptied out in the frame before the callback's enabled state caught up. The
            // flow must be consumed to the end all the same.
            try {
                events.collect { }
            } catch (_: CancellationException) {
                return@PredictiveBackHandler
            }
            onBack()
            return@PredictiveBackHandler
        }
        // The token is taken before anything can suspend: a gesture cancelled while the scene is
        // still being handed over must be able to release it.
        val gesture = scene.claimGesture()
        var edgeRead = false
        try {
            scene.beginGesture(under)
            events.collect { event ->
                if (!edgeRead) {
                    edgeRead = true
                    scene.edge = event.swipeEdge
                }
                scene.seek(event.progress)
            }
        } catch (_: CancellationException) {
            // Cancelled by the system, or superseded by a newer gesture that now owns the scene.
            if (scene.endGesture(gesture)) {
                scope.launch {
                    try {
                        scene.settle(reveal = false)
                    } catch (_: CancellationException) {
                        // Another navigation or gesture started before the rewind finished.
                    }
                }
            }
            return@PredictiveBackHandler
        }
        // Committed: pop now and let the stack observer finish the animation from where the finger left it.
        scene.endGesture(gesture)
        onBack()
    }

    val density = LocalDensity.current
    val cornerPx = with(density) { Radii.sheet.toPx() }
    val c = Murmur.colors
    // The moving screen is lifted: a shadow by day, the pill's thin light catch at night.
    val shadow = if (c.isDark) Color.Black.copy(alpha = 0.55f) else Color(0xFF2A2318).copy(alpha = 0.16f)
    val catchLight = if (c.isDark) c.hairline else Color.Transparent

    Box(modifier.fillMaxSize().clipToBounds()) {
        val under = scene.under?.takeIf { key(it) != key(scene.top) }
        val panes = if (under != null) listOf(under, scene.top) else listOf(scene.top)
        for (entry in panes) {
            val k = key(entry)
            key(k) {
                DisposableEffect(k) {
                    onDispose {
                        // A screen that left the stack is finished with; one still on it (the entry
                        // beneath, once the transition has settled) keeps its state for its return.
                        if (entry != latestCurrent && entry != latestPrevious) stateHolder.removeState(k)
                    }
                }
                stateHolder.SaveableStateProvider(k) {
                    Box(Modifier.fillMaxSize().pane(scene, entry, cornerPx, shadow, catchLight)) { content(entry) }
                }
            }
        }
    }
}

/** What is on screen and how far along the transition between the two panes is. */
@Stable
internal class BackScene<T : Any>(initialTop: T) {
    var top by mutableStateOf(initialTop)
    var under by mutableStateOf<T?>(null)

    /** 0: the top pane is at rest and alone on screen. 1: it has fully given way to [under]. */
    val progress = Animatable(0f)

    var edge by mutableIntStateOf(BackEventCompat.EDGE_LEFT)

    /** The move under way fades its screen in where it stands instead of sliding it ([BackStackHost]'s lateral). */
    var crossfade by mutableStateOf(false)

    /** Which way the top pane leaves: +1 (right) for a left-edge gesture and every programmatic pop, -1 for a right-edge one. */
    val direction: Float get() = directionFor(edge)

    private var gesture = 0
    private var gestureCount = 0
    val gestureActive: Boolean get() = gesture != 0

    /** A back gesture takes the scene over: until [endGesture] is called with the returned token, no navigation moves it. */
    fun claimGesture(): Int {
        gesture = ++gestureCount
        return gesture
    }

    /** The gesture began over [top]; [revealed] is what it uncovers. A transition toward the same pair hands over its progress. */
    suspend fun beginGesture(revealed: T) {
        crossfade = false
        if (under != revealed) {
            under = revealed
            progress.snapTo(0f)
        } else {
            progress.snapTo(progress.value)
        }
    }

    /** Ends the gesture with this token; false if a newer gesture has already taken the scene over. */
    fun endGesture(token: Int): Boolean {
        if (gesture != token) return false
        gesture = 0
        return true
    }

    suspend fun seek(fraction: Float) {
        progress.snapTo(fraction.coerceIn(0f, 1f))
    }

    /** Brings the scene in line with the stack's new [desired] top: a push when [deeper], a fade-through when [glide]. */
    suspend fun moveTo(desired: T, deeper: Boolean, glide: Boolean) {
        if (gestureActive) return
        when {
            under == null && desired == top -> return
            desired == top -> settle(reveal = false)
            desired == under -> {
                crossfade = false
                settle(reveal = true)
            }
            deeper || glide -> {
                // Push: the resident screen drops underneath and the new one arrives, playing the pop backwards.
                under = top
                top = desired
                crossfade = glide
                edge = BackEventCompat.EDGE_LEFT
                progress.snapTo(1f)
                settle(reveal = false)
            }
            else -> {
                // Pop to something that was not directly beneath (a second back mid-animation):
                // whatever is leaving keeps leaving, and the new destination is what it uncovers.
                crossfade = false
                edge = BackEventCompat.EDGE_LEFT
                under = desired
                settle(reveal = true)
            }
        }
    }

    /** Animates the rest of the way, then leaves a single resident pane: [under] if [reveal], else [top]. */
    suspend fun settle(reveal: Boolean) {
        val target = if (reveal) 1f else 0f
        val distance = abs(target - progress.value)
        if (distance > 0.001f) {
            val millis = (SettleMillis * distance).roundToInt().coerceIn(MinSettleMillis, SettleMillis)
            progress.animateTo(target, tween(millis, easing = SettleEasing))
        }
        if (reveal) under?.let { top = it }
        under = null
        crossfade = false
        progress.snapTo(0f)
    }
}

/**
 * One pane of the scene, drawn as the top or as the pane underneath by whichever it is when drawn
 * rather than when composed: the scene changes in an effect, which can run before the
 * recomposition that follows it.
 */
private fun <T : Any> Modifier.pane(scene: BackScene<T>, entry: T, cornerPx: Float, shadow: Color, catchLight: Color): Modifier = this
    .graphicsLayer {
        val p = if (scene.under == null) 0f else scene.progress.value
        translationY = 0f
        if (scene.top == entry) {
            val m = topMotion(p, scene.direction, size.width, cornerPx, scene.crossfade)
            translationX = m.translationX
            alpha = m.alpha
            shape = RoundedCornerShape(m.cornerRadius)
            clip = m.cornerRadius > 0f
            shadowElevation = if (m.cornerRadius > 0f) Elevation.overlay.toPx() else 0f
            ambientShadowColor = shadow
            spotShadowColor = shadow
        } else {
            val m = underMotion(p, scene.direction, size.width, scene.crossfade)
            translationX = m.translationX
            alpha = m.alpha
            clip = false
            shadowElevation = 0f
        }
    }
    .drawWithContent {
        drawContent()
        if (scene.top != entry || scene.under == null || scene.crossfade || catchLight.alpha <= 0f) return@drawWithContent
        val p = scene.progress.value
        if (p <= 0f) return@drawWithContent
        // The pill's light catch: a thin bright line along the lifted card's edge, at night only.
        val stroke = 1.dp.toPx()
        drawRoundRect(
            catchLight,
            topLeft = Offset(stroke / 2, stroke / 2),
            size = Size(size.width - stroke, size.height - stroke),
            cornerRadius = CornerRadius((topMotion(p, 1f, size.width, cornerPx, false).cornerRadius - stroke / 2).coerceAtLeast(0f)),
            alpha = p,
            style = Stroke(stroke)
        )
    }

// ---- the progress mapping (pure, so it can be checked) ------------------------------------------

/** Where one pane is at one moment of the transition. */
internal data class PaneMotion(val translationX: Float, val alpha: Float, val cornerRadius: Float)

/** +1: the top pane leaves to the right (a left-edge gesture, every programmatic pop); -1: to the left (a right-edge gesture). */
internal fun directionFor(edge: Int): Float = if (edge == BackEventCompat.EDGE_RIGHT) -1f else 1f

/**
 * The pane on top. Rounds its corners within the first quarter of the gesture and slides out of
 * view with the swipe until at full [progress] it is entirely off screen. It moves horizontally
 * only, keeps its size and stays opaque the whole way: the screen being left is simply carried
 * away. In a [crossfade] it stays put and fades instead.
 */
internal fun topMotion(progress: Float, direction: Float, width: Float, cornerPx: Float, crossfade: Boolean): PaneMotion {
    val p = progress.coerceIn(0f, 1f)
    if (p <= 0f || crossfade) return PaneMotion(translationX = 0f, alpha = 1f - p, cornerRadius = 0f)
    return PaneMotion(
        translationX = direction * p * width,
        alpha = 1f,
        cornerRadius = cornerPx * (p / CornerRampEnd).coerceAtMost(1f)
    )
}

/**
 * The pane underneath: fades in over the whole transition and drifts into place from a short way
 * off in the direction the top pane is leaving, so the two move as one sheet. Full size throughout.
 * What a [crossfade] covers stays where it is and is gone early in the fade, so the two screens are
 * never both legible, one through the other.
 */
internal fun underMotion(progress: Float, direction: Float, width: Float, crossfade: Boolean): PaneMotion {
    val p = progress.coerceIn(0f, 1f)
    if (crossfade) {
        return PaneMotion(translationX = 0f, alpha = ((p - CoverFadeEnd) / (1f - CoverFadeEnd)).coerceIn(0f, 1f), cornerRadius = 0f)
    }
    return PaneMotion(
        translationX = -direction * (1f - p) * width * UnderParallax,
        alpha = revealFraction(p),
        cornerRadius = 0f
    )
}

/** A smooth ramp from 0 to 1 over the whole transition: slow to start, so what is revealed comes in gradually. */
internal fun revealFraction(p: Float): Float {
    val t = p.coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
}

/** How far, as a share of the width, the revealed screen drifts in from. */
internal const val UnderParallax = 0.25f

/** Where in a crossfade (progress running 1 to 0 for a push) the screen it covers has faded out entirely. */
internal const val CoverFadeEnd = 0.5f

/** The share of the gesture over which the leaving card's corners round. */
internal const val CornerRampEnd = 0.25f

/** A full transition; shorter ones scale down with the distance left, never below [MinSettleMillis]. */
internal const val SettleMillis = 320
internal const val MinSettleMillis = 120

/** Fast out of the gate, settling gently: the screen answers the release at once and eases into place. */
private val SettleEasing: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
