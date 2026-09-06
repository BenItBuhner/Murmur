package app.murmur.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii

/** Horizontal margin every screen shares. */
val PageMargin = 24.dp

// ---- glyphs ---------------------------------------------------------------------------------
// Drawn rather than imported so the few icons the app needs share one weight and one voice.

@Composable
fun Chevron(color: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val p = Path().apply {
            moveTo(w * 0.38f, h * 0.24f)
            lineTo(w * 0.64f, h * 0.5f)
            lineTo(w * 0.38f, h * 0.76f)
        }
        drawPath(p, color, style = Stroke(1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

@Composable
fun ArrowLeft(color: Color, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val stroke = Stroke(1.7.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawLine(color, Offset(w * 0.18f, h * 0.5f), Offset(w * 0.84f, h * 0.5f), stroke.width, StrokeCap.Round)
        val head = Path().apply {
            moveTo(w * 0.44f, h * 0.24f)
            lineTo(w * 0.18f, h * 0.5f)
            lineTo(w * 0.44f, h * 0.76f)
        }
        drawPath(head, color, style = stroke)
    }
}

@Composable
fun Check(color: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val p = Path().apply {
            moveTo(w * 0.2f, h * 0.52f)
            lineTo(w * 0.42f, h * 0.74f)
            lineTo(w * 0.82f, h * 0.3f)
        }
        drawPath(p, color, style = Stroke(1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

@Composable
fun Plus(color: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val s = 1.7.dp.toPx()
        drawLine(color, Offset(w * 0.5f, h * 0.2f), Offset(w * 0.5f, h * 0.8f), s, StrokeCap.Round)
        drawLine(color, Offset(w * 0.2f, h * 0.5f), Offset(w * 0.8f, h * 0.5f), s, StrokeCap.Round)
    }
}

@Composable
fun Cross(color: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val s = 1.6.dp.toPx()
        drawLine(color, Offset(w * 0.28f, h * 0.28f), Offset(w * 0.72f, h * 0.72f), s, StrokeCap.Round)
        drawLine(color, Offset(w * 0.28f, h * 0.72f), Offset(w * 0.72f, h * 0.28f), s, StrokeCap.Round)
    }
}

/** A small dot; the only place colour shows up on a row. */
@Composable
fun Dot(color: Color, modifier: Modifier = Modifier, size: Dp = 7.dp, pulsing: Boolean = false) {
    if (!pulsing) {
        Box(modifier.size(size).background(color, CircleShape))
        return
    }
    val transition = rememberInfiniteTransition(label = "dot")
    val pulse by transition.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "pulse"
    )
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(size)
                .scale(1f + pulse * 1.1f)
                .alpha(0.35f * (1f - pulse))
                .background(color, CircleShape)
        )
        Box(Modifier.size(size).background(color, CircleShape))
    }
}

// ---- text -----------------------------------------------------------------------------------

@Composable
fun Wordmark(modifier: Modifier = Modifier) {
    Text("Murmur", style = Murmur.type.headline, color = Murmur.colors.ink, modifier = modifier)
}

/** Tracked uppercase label that introduces a group of rows. */
@Composable
fun Overline(text: String, modifier: Modifier = Modifier, color: Color = Murmur.colors.inkSoft) {
    Text(text.uppercase(), style = Murmur.type.overline, color = color, modifier = modifier)
}

@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = Murmur.colors.hairline) {
    Box(modifier.fillMaxWidth().height(1.dp).background(color))
}

/** Screen title with an optional one-line description under it. */
@Composable
fun Heading(title: String, description: String? = null, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(title, style = Murmur.type.displayMedium, color = Murmur.colors.ink)
        if (description != null) {
            Spacer(Modifier.height(10.dp))
            Text(description, style = Murmur.type.body, color = Murmur.colors.inkSoft)
        }
    }
}

/** Inline feedback under a control. */
enum class NoticeTone { NEUTRAL, SUCCESS, ERROR }

@Composable
fun Notice(text: String, tone: NoticeTone = NoticeTone.NEUTRAL, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val color = when (tone) {
        NoticeTone.NEUTRAL -> c.inkSoft
        NoticeTone.SUCCESS -> c.sage
        NoticeTone.ERROR -> c.clay
    }
    Row(modifier, verticalAlignment = Alignment.Top) {
        Dot(color, Modifier.padding(top = 6.dp), size = 6.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = Murmur.type.bodySmall, color = if (tone == NoticeTone.NEUTRAL) c.inkSoft else color)
    }
}

/** A large serif figure with its label, for the few numbers worth showing. */
@Composable
fun Statistic(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(value, style = Murmur.type.numeral, color = Murmur.colors.ink)
        Spacer(Modifier.height(6.dp))
        Overline(label)
    }
}

// ---- rows -----------------------------------------------------------------------------------

/**
 * One line of an index: what it is, what it is currently set to, and a chevron. Rows are laid
 * out edge to edge and separated by [Hairline]s by the caller.
 */
@Composable
fun NavRow(
    title: String,
    value: String? = null,
    onClick: () -> Unit,
    attention: Boolean = false,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(onClick = onClick, role = Role.Button)
            .padding(vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Murmur.type.title, color = c.ink)
            if (!value.isNullOrEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(value, style = Murmur.type.bodySmall, color = c.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (attention) {
            Dot(c.ember)
            Spacer(Modifier.width(14.dp))
        }
        Chevron(c.inkMuted)
    }
}

/** A row that says something (a feature, a fact) with a small check in front of it. */
@Composable
fun FeatureRow(text: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 13.dp), verticalAlignment = Alignment.Top) {
        Check(Murmur.colors.inkSoft, Modifier.padding(top = 3.dp))
        Spacer(Modifier.width(14.dp))
        Text(text, style = Murmur.type.body, color = Murmur.colors.ink)
    }
}

/** Label on the left, a control on the right. */
@Composable
fun ControlRow(
    title: String,
    description: String? = null,
    modifier: Modifier = Modifier,
    control: @Composable RowScope.() -> Unit
) {
    Row(modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Murmur.type.title, color = Murmur.colors.ink)
            if (description != null) {
                Spacer(Modifier.height(4.dp))
                Text(description, style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
            }
        }
        Spacer(Modifier.width(20.dp))
        control()
    }
}

@Composable
fun ToggleRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    description: String? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier
) {
    ControlRow(
        title,
        description,
        modifier
            .toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
            .alpha(if (enabled) 1f else 0.45f)
    ) {
        Toggle(checked, enabled = enabled)
    }
}

/** Minimal switch: ink track when on, hairline track when off, paper thumb. */
@Composable
fun Toggle(checked: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Murmur.colors
    val track by animateColorAsState(if (checked) c.ink else c.hairlineStrong, tween(220), label = "track")
    val offset by animateDpAsState(if (checked) 21.dp else 3.dp, tween(220, easing = FastOutSlowInEasing), label = "thumb")
    Box(
        modifier
            .width(46.dp)
            .height(28.dp)
            .background(track, CircleShape)
            .alpha(if (enabled) 1f else 0.5f)
    ) {
        Box(
            Modifier
                .offset(x = offset, y = 3.dp)
                .size(22.dp)
                .background(c.paper, CircleShape)
        )
    }
}

// ---- selection ------------------------------------------------------------------------------

data class Segment<T>(val value: T, val label: String)

/** Equal-width options in a pill; the ink indicator slides to the selection. */
@Composable
fun <T> Segmented(
    options: List<Segment<T>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    val index = options.indexOfFirst { it.value == selected }.coerceAtLeast(0)
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(42.dp)
            .background(c.paperRaised, CircleShape)
            .border(1.dp, c.hairline, CircleShape)
            .padding(3.dp)
    ) {
        val segment = maxWidth / options.size
        val x by animateDpAsState(segment * index, tween(260, easing = FastOutSlowInEasing), label = "segment")
        Box(Modifier.offset(x = x).width(segment).fillMaxHeight().background(c.ink, CircleShape))
        Row(Modifier.fillMaxSize()) {
            options.forEachIndexed { i, option ->
                val color by animateColorAsState(if (i == index) c.paper else c.inkSoft, tween(200), label = "label")
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxSize()
                        .clip(CircleShape)
                        .selectable(i == index, role = Role.RadioButton) { onSelect(option.value) },
                    contentAlignment = Alignment.Center
                ) {
                    Text(option.label, style = Murmur.type.label, color = color, maxLines = 1)
                }
            }
        }
    }
}

@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val bg by animateColorAsState(if (selected) c.ink else Color.Transparent, tween(180), label = "chip")
    val fg by animateColorAsState(if (selected) c.paper else c.ink, tween(180), label = "chipText")
    Box(
        modifier
            .clip(CircleShape)
            .background(bg)
            .border(1.dp, if (selected) Color.Transparent else c.hairlineStrong, CircleShape)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 9.dp)
    ) {
        Text(text, style = Murmur.type.label, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipRow(items: List<String>, selected: String, modifier: Modifier = Modifier, onSelect: (String) -> Unit) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (item in items) Chip(item, item == selected, onClick = { onSelect(item) })
    }
}

// ---- input ----------------------------------------------------------------------------------

@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String? = null,
    placeholder: String = "",
    helper: String? = null,
    secret: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    keyboardType: KeyboardType = KeyboardType.Text,
    focusRequester: FocusRequester? = null,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    var reveal by remember { mutableStateOf(false) }
    val border by animateColorAsState(if (focused) c.ink else c.hairline, tween(160), label = "border")
    Column(modifier) {
        if (label != null) {
            Overline(label)
            Spacer(Modifier.height(8.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .background(c.paperRaised, RoundedCornerShape(Radii.field))
                .border(1.dp, border, RoundedCornerShape(Radii.field))
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .weight(1f)
                    .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
                textStyle = Murmur.type.title.copy(color = c.ink),
                cursorBrush = SolidColor(c.ink),
                singleLine = singleLine,
                minLines = minLines,
                interactionSource = interaction,
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (secret) KeyboardType.Password else keyboardType,
                    autoCorrectEnabled = !secret && keyboardType == KeyboardType.Text
                ),
                visualTransformation = if (secret && !reveal) PasswordVisualTransformation() else VisualTransformation.None,
                decorationBox = { inner ->
                    Box {
                        if (value.isEmpty()) {
                            Text(placeholder, style = Murmur.type.title, color = c.inkMuted, maxLines = if (singleLine) 1 else Int.MAX_VALUE)
                        }
                        inner()
                    }
                }
            )
            if (secret && value.isNotEmpty()) {
                Spacer(Modifier.width(12.dp))
                TextLink(if (reveal) "Hide" else "Show", onClick = { reveal = !reveal })
            }
        }
        if (helper != null) {
            Spacer(Modifier.height(8.dp))
            Text(helper, style = Murmur.type.bodySmall, color = c.inkSoft)
        }
    }
}

// ---- buttons --------------------------------------------------------------------------------

enum class ButtonTone { INK, EMBER }

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    tone: ButtonTone = ButtonTone.INK
) {
    val c = Murmur.colors
    val fill = when {
        !enabled -> c.paperRaised
        tone == ButtonTone.EMBER -> c.ember
        else -> c.ink
    }
    val fg = when {
        !enabled -> c.inkMuted
        tone == ButtonTone.EMBER -> Color.White
        else -> c.paper
    }
    Row(
        modifier
            .height(52.dp)
            .clip(CircleShape)
            .background(fill)
            .then(if (!enabled) Modifier.border(1.dp, c.hairline, CircleShape) else Modifier)
            .clickable(enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(16.dp), color = fg, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(text, style = Murmur.type.label, color = fg, maxLines = 1)
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    compact: Boolean = false,
    loading: Boolean = false
) {
    val c = Murmur.colors
    val fg = if (enabled) c.ink else c.inkMuted
    Row(
        modifier
            .height(if (compact) 36.dp else 46.dp)
            .clip(CircleShape)
            .border(BorderStroke(1.dp, if (enabled) c.hairlineStrong else c.hairline), CircleShape)
            .clickable(enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (compact) 16.dp else 22.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(14.dp), color = fg, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = if (compact) Murmur.type.labelSmall else Murmur.type.label, color = fg, maxLines = 1)
    }
}

/** Quiet inline action. */
@Composable
fun TextLink(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Murmur.colors.inkSoft) {
    Text(
        text,
        style = Murmur.type.label,
        color = color,
        modifier = modifier
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp)
    )
}

/** Circular hit area around a glyph. */
@Composable
fun GlyphButton(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .size(40.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
        content = content
    )
}

// ---- surfaces -------------------------------------------------------------------------------

/** The dark block the live dictation button is shown on. */
@Composable
fun Stage(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radii.block))
            .background(Murmur.colors.stage),
        content = content
    )
}

/** Thin progress bars, one per step. */
@Composable
fun StepIndicator(count: Int, current: Int, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (i in 0 until count) {
            val color by animateColorAsState(if (i <= current) c.ink else c.hairline, tween(300), label = "step")
            Box(Modifier.weight(1f).height(2.dp).background(color, CircleShape))
        }
    }
}

// ---- screen scaffold ------------------------------------------------------------------------

/**
 * Every settings screen: a back arrow, a serif title, a line of context, then the content in a
 * scrolling column with the page margin applied.
 */
@Composable
fun Screen(
    title: String,
    description: String? = null,
    onBack: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val c = Murmur.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
            .imePadding()
    ) {
        Row(
            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = PageMargin - 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (onBack != null) {
                GlyphButton(onClick = onBack) { ArrowLeft(c.ink) }
            }
            Spacer(Modifier.weight(1f))
            trailing?.invoke(this)
        }
        Column(Modifier.padding(horizontal = PageMargin)) {
            Spacer(Modifier.height(12.dp))
            Heading(title, description)
            Spacer(Modifier.height(32.dp))
            content()
            Spacer(Modifier.height(40.dp))
        }
    }
}

/** Vertical rhythm between groups on a screen. */
@Composable
fun SectionGap() {
    Spacer(Modifier.height(36.dp))
}

/** A group label followed by its rows. */
@Composable
fun Group(label: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        if (label != null) {
            Overline(label)
            Spacer(Modifier.height(6.dp))
        }
        content()
    }
}
