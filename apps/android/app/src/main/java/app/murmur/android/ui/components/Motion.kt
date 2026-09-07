package app.murmur.android.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateIntAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import app.murmur.android.ui.theme.Murmur

/*
 * Motion shared by the screens. Material 3's emphasized easings: things arriving decelerate into
 * place, things leaving accelerate away, and a screen's blocks arrive one beat after another.
 */

/** Material's emphasized decelerate: for anything entering the screen. */
val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)

/** Material's emphasized accelerate: for anything leaving. */
val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

/** Beat between two blocks of a staggered entrance. */
private const val StaggerMs = 45

/**
 * One block of a screen's entrance: it fades and rises into place [index] beats after the first.
 * Plays once, when the block is first composed; it never plays on the way out.
 */
@Composable
fun Reveal(index: Int, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val shown = remember { MutableTransitionState(false).apply { targetState = true } }
    val delay = (index * StaggerMs).coerceAtMost(8 * StaggerMs)
    AnimatedVisibility(
        visibleState = shown,
        modifier = modifier,
        enter = fadeIn(tween(300, delayMillis = delay, easing = LinearOutSlowInEasing)) +
            slideInVertically(tween(440, delayMillis = delay, easing = EmphasizedDecelerate)) { it / 6 },
        exit = ExitTransition.None
    ) { content() }
}

/**
 * Something that comes and goes with a condition (a notice, a card): it grows in as it fades in,
 * and folds away as it fades out, so the blocks around it slide rather than jump.
 */
@Composable
fun Appear(visible: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    AnimatedVisibility(
        visible = visible,
        modifier = modifier,
        enter = fadeIn(tween(220, delayMillis = 80)) + expandVertically(tween(300, easing = EmphasizedDecelerate)),
        exit = fadeOut(tween(120)) + shrinkVertically(tween(260, easing = EmphasizedAccelerate))
    ) { content() }
}

/**
 * A number that counts up to [value] the first time it is shown and glides to every new value
 * after that. Large numerals read better arriving than appearing.
 */
@Composable
fun CountUp(
    value: Int,
    modifier: Modifier = Modifier,
    style: TextStyle = Murmur.type.numeral,
    color: Color = Murmur.colors.ink,
    durationMs: Int = 900,
    format: (Int) -> String = { it.toString() }
) {
    var target by remember { mutableIntStateOf(0) }
    LaunchedEffect(value) { target = value }
    val shown by animateIntAsState(target, tween(durationMs, easing = EmphasizedDecelerate), label = "count")
    Text(format(shown), style = style, color = color, modifier = modifier, maxLines = 1)
}

/** A short label that changes: the old one slips up and out as the new one rises in. */
@Composable
fun RollingText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    AnimatedContent(
        targetState = text,
        modifier = modifier,
        transitionSpec = {
            (fadeIn(tween(200, delayMillis = 60)) + slideInVertically(tween(260, delayMillis = 60, easing = EmphasizedDecelerate)) { it / 2 })
                .togetherWith(fadeOut(tween(120)) + slideOutVertically(tween(160, easing = EmphasizedAccelerate)) { -it / 2 })
        },
        label = "rolling"
    ) { Text(it, style = style, color = color, maxLines = 1) }
}

/** 0 the first time it is composed, 1 shortly after: drives draw-in effects (bars growing). */
@Composable
fun rememberDrawIn(durationMs: Int = 700, delayMs: Int = 120): Float {
    var target by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { target = 1 }
    val progress by animateFloatAsState(
        target.toFloat(),
        tween(durationMs, delayMillis = delayMs, easing = EmphasizedDecelerate),
        label = "drawIn"
    )
    return progress
}
