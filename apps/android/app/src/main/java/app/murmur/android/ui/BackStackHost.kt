package app.murmur.android.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import kotlinx.coroutines.CancellationException
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sign

/** How a screen leaves when the user goes back. */
enum class BackMotion {
    /**
     * A full-screen surface: it shrinks under the finger, is pushed the way the finger moves and
     * lifts off the dimmed screen below, the way the system takes an app home.
     */
    SURFACE,

    /** A page inside chrome that stays put: the shared axis simply runs backwards. */
    PAGE
}

/**
 * Shows the top of a back stack and animates between its entries. Forward is a horizontal shared
 * axis. Back follows the system's predictive back gesture: while the finger is down the transition
 * is scrubbed by the gesture's progress, so the user sees where back leads before committing to
 * it; letting go finishes the motion and pops, a cancelled gesture runs it back to where it was.
 * A back press, or the app's own back arrow, plays the same motion end to end.
 *
 * At the root ([previous] is null) back is left to the system, which animates the whole app away.
 *
 * @param current the entry on top.
 * @param previous the entry a back gesture reveals; null at the root.
 * @param depth deeper entries sit on top of shallower ones, and moving deeper is forward.
 * @param onBack pops the stack; called once a back gesture or press has been committed.
 */
@Composable
fun <T : Any> BackStackHost(
    current: T,
    previous: T?,
    depth: (T) -> Int,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    motion: BackMotion = BackMotion.SURFACE,
    content: @Composable (T) -> Unit
) {
    val state = remember { SeekableTransitionState(current) }
    val stack = rememberTransition(state, label = "backStack")
    // While a finger is on a back gesture the transition is seeked by it instead of animated.
    var seeking by remember { mutableStateOf(false) }
    // Where the finger was last; it keeps steering the lifted surface until the transition settles.
    var gesture by remember { mutableStateOf<BackGesture?>(null) }

    PredictiveBackHandler(enabled = previous != null) { events ->
        var startY = Float.NaN
        try {
            events.collect { event ->
                if (startY.isNaN()) startY = event.touchY
                gesture = BackGesture(
                    progress = event.progress,
                    fromLeft = event.swipeEdge == BackEventCompat.EDGE_LEFT,
                    dy = event.touchY - startY
                )
                seeking = true
            }
            seeking = false
            onBack()
        } catch (e: CancellationException) {
            seeking = false
        }
    }

    if (seeking && previous != null) {
        val progress = gesture?.progress ?: 0f
        LaunchedEffect(progress) { state.seekTo(progress, previous) }
    } else {
        LaunchedEffect(current) {
            when {
                state.currentState != current -> state.animateTo(current)
                state.targetState != current -> state.unwind(current)
            }
            gesture = null
        }
    }

    stack.AnimatedContent(
        modifier = modifier,
        transitionSpec = {
            val forward = depth(targetState) > depth(initialState)
            val zIndex = depth(targetState).toFloat()
            when {
                forward -> ContentTransform(
                    slideInHorizontally(standard()) { it / 5 } + fadeIn(standard()),
                    slideOutHorizontally(standard()) { -it / 5 } + fadeOut(standard()),
                    targetContentZIndex = zIndex
                )
                motion == BackMotion.PAGE -> ContentTransform(
                    slideInHorizontally(standard()) { -it / 5 } + fadeIn(standard()),
                    slideOutHorizontally(standard()) { it / 5 } + fadeOut(standard()),
                    targetContentZIndex = zIndex
                )
                // The screen below slides back into place while the one on top shrinks (see
                // Modifier.surface) and only dissolves over the last stretch.
                else -> ContentTransform(
                    slideInHorizontally(standard()) { -it / 5 },
                    fadeOut(tween(Duration * 2 / 5, delayMillis = Duration * 3 / 5, easing = LinearEasing)),
                    targetContentZIndex = zIndex
                )
            }
        }
    ) { entry ->
        // Of the two screens in flight, the deeper one is the surface the finger moves and the
        // other is the ground it lifts off.
        val other = if (stack.targetState == entry) stack.currentState else stack.targetState
        val surface = depth(entry) > depth(other)
        val pop = depth(stack.targetState) < depth(stack.currentState)
        val lift by transition.animateFloat(
            transitionSpec = { tween(Duration, easing = StandardDecelerate) },
            label = "lift"
        ) { if (it == EnterExitState.PostExit) 1f else 0f }
        val reveal by transition.animateFloat(
            transitionSpec = { tween(Duration, easing = StandardDecelerate) },
            label = "reveal"
        ) { if (it == EnterExitState.PreEnter) 0f else 1f }
        // Like Stage: at night a hairline keeps the lifted surface's edge.
        val edge = Murmur.colors.let { if (it.isDark) it.hairline else Color.Transparent }
        Box(
            when {
                motion != BackMotion.SURFACE -> Modifier
                surface -> Modifier.surface({ lift }, { gesture }, edge)
                pop -> Modifier.ground { 1f - reveal }
                else -> Modifier
            }
        ) { content(entry) }
    }
}

/** Length of every transition, and so of the stretch a back gesture scrubs through. */
private const val Duration = 300

/** Material's standard decelerate: the surface answers the finger at once and settles gently. */
private val StandardDecelerate = CubicBezierEasing(0f, 0f, 0f, 1f)

private fun <T> standard() = tween<T>(Duration, easing = FastOutSlowInEasing)

/**
 * A cancelled gesture: run the transition backwards from where the finger let go, over the share
 * of [Duration] it had covered, then settle on [current] with nothing left running. Animating to
 * [current] instead would swap the transition's two states and replay it as a forward move.
 */
private suspend fun <T> SeekableTransitionState<T>.unwind(current: T) {
    val from = fraction
    val nanos = (from * Duration).roundToInt() * 1_000_000L
    if (nanos > 0) {
        val start = withFrameNanos { it }
        var t = 0f
        while (t < 1f) {
            t = ((withFrameNanos { it } - start).toFloat() / nanos).coerceAtMost(1f)
            seekTo(from * (1f - FastOutSlowInEasing.transform(t)))
        }
    }
    snapTo(current)
}

// ---- the lifted surface --------------------------------------------------------------------

/** The system back gesture in flight, as far as the surface under the finger needs to know. */
internal data class BackGesture(
    /** 0 at the edge, 1 at the far end of the gesture's range. */
    val progress: Float,
    /** Started at the left edge: the surface is pushed to the right, the way the finger moves. */
    val fromLeft: Boolean,
    /** How far the finger has drifted up or down since the gesture began, in pixels. */
    val dy: Float
)

/** Where the outgoing surface is at one moment of its lift-off. */
internal data class SurfaceMotion(
    val scale: Float,
    val translationX: Float,
    val translationY: Float,
    val cornerRadius: Float
)

private const val MinScale = 0.9f
private val EdgeGap = 8.dp
private val MaxTranslationY = 100.dp
private const val Scrim = 0.14f

/**
 * Material's predictive-back motion for a full-screen surface, with the numbers the system's own
 * cross-activity animation and material-components' back helper use: at [lift] 1 the surface has
 * shrunk to 90 %, sits [edgeGap] from the edge the finger is heading for, has followed the finger
 * up or down by at most [maxTranslationY], and its corners have rounded to [cornerRadius]. With no
 * [gesture] (a back arrow or button) it shrinks in place.
 */
internal fun surfaceMotion(
    lift: Float,
    gesture: BackGesture?,
    width: Float,
    height: Float,
    edgeGap: Float,
    maxTranslationY: Float,
    cornerRadius: Float
): SurfaceMotion {
    val scale = lerp(1f, MinScale, lift)
    var translationX = 0f
    var translationY = 0f
    if (gesture != null && width > 0f && height > 0f) {
        val room = ((width - width * MinScale) / 2 - edgeGap).coerceAtLeast(0f)
        translationX = lerp(0f, room, lift) * (if (gesture.fromLeft) 1f else -1f)
        val headroom = min(((height - height * scale) / 2 - edgeGap).coerceAtLeast(0f), maxTranslationY)
        translationY = lerp(0f, headroom, (abs(gesture.dy) / height).coerceAtMost(1f)) * sign(gesture.dy)
    }
    return SurfaceMotion(scale, translationX, translationY, lerp(0f, cornerRadius, lift))
}

/** Lifts the surface the user is backing out of; [lift] runs 0..1 as it leaves. */
private fun Modifier.surface(lift: () -> Float, gesture: () -> BackGesture?, edge: Color): Modifier = this
    .graphicsLayer {
        val m = surfaceMotion(
            lift(), gesture(), size.width, size.height,
            EdgeGap.toPx(), MaxTranslationY.toPx(), Radii.block.toPx()
        )
        scaleX = m.scale
        scaleY = m.scale
        translationX = m.translationX
        translationY = m.translationY
        shape = RoundedCornerShape(m.cornerRadius)
        clip = m.cornerRadius > 0f
    }
    .drawWithContent {
        drawContent()
        val p = lift()
        if (p > 0f && edge.alpha > 0f) {
            val stroke = 1.dp.toPx()
            drawRoundRect(
                edge,
                topLeft = Offset(stroke / 2, stroke / 2),
                size = Size(size.width - stroke, size.height - stroke),
                cornerRadius = CornerRadius((lerp(0f, Radii.block.toPx(), p) - stroke / 2).coerceAtLeast(0f)),
                alpha = p,
                style = Stroke(stroke)
            )
        }
    }

/** The screen being revealed underneath, dimmed by how much of the way it still has to come. */
private fun Modifier.ground(hidden: () -> Float): Modifier = drawWithContent {
    drawContent()
    val h = hidden()
    if (h > 0f) drawRect(Color.Black, alpha = Scrim * h)
}
