package app.murmur.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
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
import app.murmur.android.ui.TopNav
import app.murmur.android.ui.TopNavButton
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import app.murmur.android.ui.theme.surface

/** Horizontal margin every screen shares. */
val PageMargin = Space.gutter

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

/** A chevron pointing down: something opens below. */
@Composable
fun ChevronDown(color: Color, modifier: Modifier = Modifier, size: Dp = 16.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val p = Path().apply {
            moveTo(w * 0.24f, h * 0.38f)
            lineTo(w * 0.5f, h * 0.64f)
            lineTo(w * 0.76f, h * 0.38f)
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

/** The name, set in the display serif. Murmur has no mark yet; the word is the mark. */
@Composable
fun Wordmark(modifier: Modifier = Modifier) {
    Text("Murmur", style = Murmur.type.headline, color = Murmur.colors.ink, modifier = modifier)
}

/** Tracked uppercase label that introduces a group of rows. */
@Composable
fun Overline(text: String, modifier: Modifier = Modifier, color: Color = Murmur.colors.inkSoft) {
    Text(text.uppercase(), style = Murmur.type.overline, color = color, modifier = modifier)
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

// ---- surfaces -------------------------------------------------------------------------------

/**
 * A raised card on the paper: the card radius, the card padding, the raised elevation. Rows
 * inside it are set apart by rhythm alone.
 */
@Composable
fun Card(
    modifier: Modifier = Modifier,
    padding: PaddingValues = PaddingValues(Space.card),
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val shape = RoundedCornerShape(Radii.card)
    Column(
        modifier
            .fillMaxWidth()
            .surface(Elevation.raised, shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(padding),
        content = content
    )
}

/**
 * A card that holds a list: tight padding, and each row a surface one radius step in
 * ([Radii.md] = card - cardTight), so the corners stay concentric.
 */
@Composable
fun ListCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier, padding = PaddingValues(Space.cardTight), content = content)
}

/** One row of a [ListCard]: rounded to the nested radius, with room for a tap. */
@Composable
fun ListRow(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    verticalAlignment: Alignment.Vertical = Alignment.CenterVertically,
    content: @Composable RowScope.() -> Unit
) {
    val shape = RoundedCornerShape(Radii.nested(Radii.card, Space.cardTight))
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = Space.md, vertical = Space.md),
        verticalAlignment = verticalAlignment,
        content = content
    )
}

/** A well: a panel sunk into whatever holds it, at the field radius. */
@Composable
fun Well(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(horizontal = 14.dp, vertical = 12.dp), content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radii.md))
            .background(Murmur.colors.paperRaised)
            .padding(padding),
        content = content
    )
}

/** A small filled label for a stage or an outcome: a well with round ends, tinted when it carries a meaning. */
@Composable
fun Tag(text: String, color: Color = Murmur.colors.inkSoft, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val tinted = color != c.inkSoft
    Text(
        text,
        style = Murmur.type.labelSmall,
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .clip(CircleShape)
            .background(if (tinted) color.copy(alpha = 0.14f) else c.paperRaised)
            .padding(horizontal = 9.dp, vertical = 3.dp)
    )
}

// ---- rows -----------------------------------------------------------------------------------

/**
 * One line of an index: what it is, what it is currently set to, and a chevron. Rows sit inside
 * a card and are set apart by rhythm.
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
            .padding(vertical = Space.row),
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
    Row(modifier.fillMaxWidth().padding(vertical = 9.dp), verticalAlignment = Alignment.Top) {
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
    Row(modifier.fillMaxWidth().padding(vertical = Space.row), verticalAlignment = Alignment.CenterVertically) {
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

/** Minimal switch: an ink track when on, a deeper well when off, a raised paper thumb. */
@Composable
fun Toggle(checked: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Murmur.colors
    val track by animateColorAsState(if (checked) c.ink else c.hairlineStrong.copy(alpha = 0.55f), tween(220), label = "track")
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
                .surface(Elevation.raised, CircleShape, color = c.card)
        )
    }
}

// ---- selection ------------------------------------------------------------------------------

data class Segment<T>(val value: T, val label: String)

/** Equal-width options in a well; the ink indicator slides to the selection (a pill in a pill). */
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

/** A choice in a set: a well when resting, ink when chosen. */
@Composable
fun Chip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    val bg by animateColorAsState(if (selected) c.ink else c.paperRaised, tween(180), label = "chip")
    val fg by animateColorAsState(if (selected) c.paper else c.ink, tween(180), label = "chipText")
    Box(
        modifier
            .clip(CircleShape)
            .background(bg)
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

/** A field is a well at the field radius. Focus draws the one ring the app allows itself. */
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
    val ring by animateColorAsState(if (focused) c.ink.copy(alpha = 0.6f) else Color.Transparent, tween(160), label = "ring")
    val shape = RoundedCornerShape(Radii.field)
    Column(modifier) {
        if (label != null) {
            Overline(label)
            Spacer(Modifier.height(8.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .background(c.paperRaised, shape)
                .border(1.5.dp, ring, shape)
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
        tone == ButtonTone.EMBER -> c.onEmber
        else -> c.paper
    }
    Row(
        modifier
            .height(52.dp)
            .clip(CircleShape)
            .background(fill)
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

/** The tonal button: a well with round ends, no edge. */
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
            .background(c.paperRaised)
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

/**
 * The keyboard-like block the live dictation button is shown on: near-black at night, keyboard
 * grey by day, so the pill previews over the brightness it will actually float on. A sunk
 * surface at the card radius; no edge.
 */
@Composable
fun Stage(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val c = Murmur.colors
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radii.card))
            .background(c.stage),
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

/** The row above every screen: the sections button or a back arrow on the left, actions on the right. */
@Composable
fun TopBar(nav: TopNav?, trailing: (@Composable RowScope.() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).padding(horizontal = PageMargin - 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (nav != null) TopNavButton(nav)
        Spacer(Modifier.weight(1f))
        trailing?.invoke(this)
    }
}

/**
 * Every settings screen: the sections button (or a back arrow, when the screen was pushed), a
 * serif title, a line of context, then the content in a scrolling column with the page margin
 * applied.
 */
@Composable
fun Screen(
    title: String,
    description: String? = null,
    nav: TopNav? = null,
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
        TopBar(nav, trailing)
        Column(Modifier.padding(horizontal = PageMargin)) {
            Spacer(Modifier.height(12.dp))
            Heading(title, description)
            Spacer(Modifier.height(Space.block))
            content()
            Spacer(Modifier.height(40.dp))
        }
    }
}

/**
 * The same chrome as [Screen] over a lazy list, for screens whose content can run to hundreds of
 * rows. [header] sits under the heading and scrolls with the list; [items] fill the rest.
 */
@Composable
fun LazyScreen(
    title: String,
    description: String? = null,
    nav: TopNav? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    state: LazyListState = rememberLazyListState(),
    header: (@Composable ColumnScope.() -> Unit)? = null,
    items: LazyListScope.() -> Unit
) {
    val c = Murmur.colors
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .imePadding()
    ) {
        TopBar(nav, trailing)
        LazyColumn(
            Modifier.weight(1f),
            state = state,
            contentPadding = PaddingValues(start = PageMargin, end = PageMargin, bottom = bottom + 40.dp)
        ) {
            item(key = "heading") {
                Column {
                    Spacer(Modifier.height(12.dp))
                    Heading(title, description)
                    Spacer(Modifier.height(if (header != null) 24.dp else Space.block))
                    header?.invoke(this)
                }
            }
            items()
        }
    }
}

/** Vertical rhythm between groups on a screen. */
@Composable
fun SectionGap() {
    Spacer(Modifier.height(Space.block))
}

/**
 * A group: an overline, an optional line of context, and a raised card holding the content.
 * The card is what sets a group apart; nothing is ruled. [rows] trims the card's vertical
 * padding for content made of [ControlRow]s, which bring their own rhythm.
 */
@Composable
fun Group(
    label: String? = null,
    description: String? = null,
    rows: Boolean = false,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(Modifier.fillMaxWidth()) {
        if (label != null) {
            Overline(label)
            if (description != null) {
                Spacer(Modifier.height(8.dp))
                Text(description, style = Murmur.type.bodySmall, color = Murmur.colors.inkSoft)
            }
            Spacer(Modifier.height(10.dp))
        }
        Card(padding = if (rows) RowCardPadding else PaddingValues(Space.card), content = content)
    }
}

/** Card padding for content made of rows: the rows' own rhythm supplies the rest. */
val RowCardPadding = PaddingValues(horizontal = Space.card, vertical = Space.xs)
