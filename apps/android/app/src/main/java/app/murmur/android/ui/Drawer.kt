package app.murmur.android.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.MutatorMutex
import androidx.compose.foundation.gestures.DragScope
import androidx.compose.foundation.gestures.DraggableState
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.systemGestures
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DrawerValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.theme.Murmur
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/*
 * The phone's sections drawer, ported from Cursor for Android's sidebar drawer: a sheet the width
 * of the drawer that rests off the start edge and slides in over a scrim. One value, how far open
 * the sheet is, drives everything, whether the sheet is being dragged, animated open or closed, or
 * scrubbed by the predictive back gesture. The gesture moves the sheet back toward its edge in step
 * with the finger and nothing else: no shrinking, and the same motion whichever edge the swipe came
 * from. Letting go commits or rewinds the slide from wherever the finger left it, over a duration in
 * proportion to the distance still to go. Material's ModalNavigationDrawer answers the gesture by
 * scaling the sheet down and keeps its offset to itself, so it cannot be made to simply follow the
 * finger.
 */

/**
 * The drawer and the screen under it. Shut, a drag anywhere pulls the sheet in, except one that
 * starts in either of the window's back-gesture strips ([BackGestureEdges]): that is the system's
 * back swipe, and the drawer does not so much as twitch for it. Open, back closes the drawer before
 * anything underneath gets to pop; the screens stand their own handler down while it is open.
 */
@Composable
fun MurmurDrawer(
    state: MurmurDrawerState,
    drawerWidth: Dp,
    modifier: Modifier = Modifier,
    gesturesEnabled: Boolean = true,
    scrimColor: Color = Murmur.colors.scrim,
    drawerContent: @Composable () -> Unit,
    content: @Composable () -> Unit
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val widthPx = with(density) { drawerWidth.toPx() }
    val flingThreshold = with(density) { FlingThreshold.toPx() } / widthPx
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val edges = rememberBackGestureEdges()
    val drag = remember(state, edges) { DrawerDrag(state, edges) }
    SideEffect { state.widthPx = widthPx }

    Box(
        modifier
            .fillMaxSize()
            .backGestureEdges(edges)
            .draggable(
                state = drag,
                orientation = Orientation.Horizontal,
                enabled = gesturesEnabled,
                reverseDirection = rtl,
                startDragImmediately = state.isAnimating,
                onDragStopped = { velocity -> if (!drag.lettingBe) state.settle(velocity / widthPx, flingThreshold) }
            )
    ) {
        content()

        PredictiveBackHandler(enabled = state.isOpen) { events ->
            val start = state.fraction
            try {
                events.collect { state.seek(start * (1f - it.progress)) }
            } catch (_: CancellationException) {
                // The handler's own coroutine is the one cancelled; the rewind runs somewhere that outlives it.
                scope.launch { state.slideTo(DrawerValue.Open) }
                return@PredictiveBackHandler
            }
            scope.launch { state.slideTo(DrawerValue.Closed) }
        }

        Scrim(
            open = state.isOpen,
            onClose = { if (gesturesEnabled) scope.launch { state.close() } },
            fraction = { state.fraction },
            color = scrimColor
        )
        Box(
            Modifier
                .fillMaxHeight()
                .width(drawerWidth)
                .offset { IntOffset((-(1f - state.fraction) * widthPx).roundToInt(), 0) }
                // Shut, the sheet rests just off screen; without this its shadow would still catch the edge.
                .graphicsLayer { alpha = if (state.fraction > 0.001f) 1f else 0f }
                .semantics {
                    paneTitle = NavigationMenu
                    if (state.isOpen) {
                        dismiss {
                            scope.launch { state.close() }
                            true
                        }
                    }
                }
        ) { drawerContent() }
    }
}

/** Where the drawer is and where it is heading. Survives configuration changes through [Saver]. */
@Stable
class MurmurDrawerState(initialValue: DrawerValue) {
    /** 0: the sheet rests off screen. 1: it is fully open. Anything between is a drag, an animation or a gesture. */
    var fraction by mutableFloatStateOf(if (initialValue == DrawerValue.Open) 1f else 0f)
        private set

    /** Where the sheet will come to rest: unchanged by a drag or a gesture until the finger lets go. */
    var targetValue by mutableStateOf(initialValue)
        private set

    val isOpen: Boolean get() = targetValue == DrawerValue.Open

    var isAnimating by mutableStateOf(false)
        private set

    internal var widthPx = 0f

    private val mutex = MutatorMutex()

    suspend fun open() = slideTo(DrawerValue.Open)

    suspend fun close() = slideTo(DrawerValue.Closed)

    /** Animates to [value] from wherever the sheet is now, taking longer the further it has to travel. */
    internal suspend fun slideTo(value: DrawerValue) {
        val target = value.fraction
        mutex.mutate {
            targetValue = value
            val distance = abs(target - fraction)
            if (distance < 0.001f) {
                fraction = target
                return@mutate
            }
            val millis = (SlideMillis * distance).roundToInt().coerceIn(MinSlideMillis, SlideMillis)
            runAnimation { animate(fraction, target, animationSpec = tween(millis, easing = SlideEasing)) { v, _ -> fraction = v } }
        }
    }

    /** Puts the sheet at [fraction] for this frame of a back gesture, taking over from any animation in flight. */
    internal suspend fun seek(fraction: Float) {
        mutex.mutate(MutatePriority.UserInput) { this.fraction = fraction.coerceIn(0f, 1f) }
    }

    /**
     * The finger lifted after a drag with [velocity] (in sheet widths per second). A fling past
     * [flingThreshold] decides the direction; otherwise the nearer resting place does. The velocity
     * carries into the animation.
     */
    internal suspend fun settle(velocity: Float, flingThreshold: Float) {
        val value = when {
            velocity > flingThreshold -> DrawerValue.Open
            velocity < -flingThreshold -> DrawerValue.Closed
            fraction >= 0.5f -> DrawerValue.Open
            else -> DrawerValue.Closed
        }
        mutex.mutate {
            targetValue = value
            runAnimation {
                animate(fraction, value.fraction, initialVelocity = velocity, animationSpec = FlingSpec) { v, _ ->
                    fraction = v.coerceIn(0f, 1f)
                }
            }
        }
    }

    private suspend inline fun runAnimation(block: () -> Unit) {
        isAnimating = true
        try {
            block()
        } finally {
            isAnimating = false
        }
    }

    /** Dragging holds the mutex for the whole gesture, so an animation cannot fight the finger. */
    internal val draggableState: DraggableState = object : DraggableState {
        private val dragScope = object : DragScope {
            override fun dragBy(pixels: Float) {
                if (widthPx <= 0f) return
                fraction = (fraction + pixels / widthPx).coerceIn(0f, 1f)
            }
        }

        override suspend fun drag(dragPriority: MutatePriority, block: suspend DragScope.() -> Unit) {
            mutex.mutate(dragPriority) { dragScope.block() }
        }

        override fun dispatchRawDelta(delta: Float) = dragScope.dragBy(delta)
    }

    companion object {
        val Saver: Saver<MurmurDrawerState, DrawerValue> = Saver(save = { it.targetValue }, restore = { MurmurDrawerState(it) })
    }
}

@Composable
fun rememberMurmurDrawerState(initialValue: DrawerValue = DrawerValue.Closed): MurmurDrawerState =
    rememberSaveable(saver = MurmurDrawerState.Saver) { MurmurDrawerState(initialValue) }

private val DrawerValue.fraction: Float get() = if (this == DrawerValue.Open) 1f else 0f

/**
 * The drawer's drag, which lets one kind be: a drag whose finger went down in a back-gesture strip
 * while the drawer was shut is the system's back swipe, and moves nothing. Decided as the drag
 * begins; such a drag takes no hold of the sheet either, so a slide already under way plays on.
 */
private class DrawerDrag(private val state: MurmurDrawerState, private val edges: BackGestureEdges) : DraggableState {
    /** Whether the drag under way, or the last one, is one the drawer lets be. */
    var lettingBe = false
        private set

    override suspend fun drag(dragPriority: MutatePriority, block: suspend DragScope.() -> Unit) {
        lettingBe = edges.gestureStartedInEdge && !state.isOpen
        if (lettingBe) StandStill.block() else state.draggableState.drag(dragPriority, block)
    }

    override fun dispatchRawDelta(delta: Float) = state.draggableState.dispatchRawDelta(delta)
}

private object StandStill : DragScope {
    override fun dragBy(pixels: Float) = Unit
}

/** Darkens the screen behind the sheet in step with how far open it is; a tap on it closes the drawer. */
@Composable
private fun Scrim(open: Boolean, onClose: () -> Unit, fraction: () -> Float, color: Color) {
    val dismissDrawer = if (open) {
        Modifier
            .pointerInput(onClose) { detectTapGestures { onClose() } }
            .semantics(mergeDescendants = true) {
                contentDescription = CloseNavigationMenu
                onClick {
                    onClose()
                    true
                }
            }
    } else {
        Modifier
    }
    Canvas(Modifier.fillMaxSize().then(dismissDrawer)) { drawRect(color, alpha = fraction()) }
}

/**
 * Where Android's back gesture begins, a strip down each side of the window, and whether the
 * gesture under way began in one. The system takes the pointer only once it has seen the finger
 * move; until then the app is handed the same down and first moves, and a sheet that answered
 * them would already be sliding in when the system's cancel arrived. Each strip is as wide as the
 * window's system gesture insets make it on that side, and never narrower than [BackEdgeMinWidth]:
 * 3-button navigation reports no side insets at all.
 */
@Stable
class BackGestureEdges internal constructor(private val insets: WindowInsets, private val density: Density) {
    internal var coordinates: LayoutCoordinates? = null

    /** Whether the gesture under way began in a strip: decided on its first finger down, and kept until the next gesture's. */
    var gestureStartedInEdge: Boolean = false
        private set

    val leftPx: Int get() = maxOf(insets.getLeft(density, LayoutDirection.Ltr), minPx)

    val rightPx: Int get() = maxOf(insets.getRight(density, LayoutDirection.Ltr), minPx)

    private val minPx: Int get() = with(density) { BackEdgeMinWidth.roundToPx() }

    internal fun startGesture(position: Offset) {
        val coordinates = coordinates?.takeIf { it.isAttached }
        gestureStartedInEdge = coordinates != null &&
            inEdge(coordinates.localToRoot(position).x, coordinates.findRootCoordinates().size.width)
    }

    private fun inEdge(x: Float, windowWidth: Int): Boolean = x < leftPx || x >= windowWidth - rightPx
}

@Composable
fun rememberBackGestureEdges(): BackGestureEdges {
    val insets = WindowInsets.systemGestures
    val density = LocalDensity.current
    return remember(insets, density) { BackGestureEdges(insets, density) }
}

/**
 * Keeps [edges] told where each gesture begins. Its first finger is seen on the initial pass,
 * before anything inside has seen it, and nothing is consumed.
 */
fun Modifier.backGestureEdges(edges: BackGestureEdges): Modifier =
    onPlaced { edges.coordinates = it }
        .pointerInput(edges) {
            awaitEachGesture { edges.startGesture(awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial).position) }
        }

/** The narrowest a strip is, whatever the window reports. */
val BackEdgeMinWidth = 16.dp

private const val NavigationMenu = "Navigation menu"
private const val CloseNavigationMenu = "Close navigation menu"

/** A full-width slide; shorter ones scale down with the distance, never below [MinSlideMillis]. */
private const val SlideMillis = 300
private const val MinSlideMillis = 100

/** Fast out of the gate, settling gently: the same curve the back stack settles its screens with. */
private val SlideEasing: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

/** A drag let go with a fling faster than this (per second, in dp of travel) decides the direction on its own. */
private val FlingThreshold = 400.dp

/** Carries a released drag's velocity into the rest of the slide without overshooting. */
private val FlingSpec = spring<Float>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 1000f, visibilityThreshold = 0.0005f)
