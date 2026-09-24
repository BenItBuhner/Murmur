package app.murmur.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii

/**
 * A whole number with a unit, in a compact well that sits at the right of a [ControlRow] (the
 * desktop's number input with its "s" suffix). Digits typed inside [range] apply as they are
 * typed; anything else is clamped into the range when the field is left, and the field shows
 * what was actually kept.
 */
@Composable
fun UnitNumberControl(
    value: Int,
    range: IntRange,
    onChange: (Int) -> Unit,
    unit: String,
    label: String,
    enabled: Boolean = true,
    modifier: Modifier = Modifier
) {
    val c = Murmur.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    var text by remember(value) { mutableStateOf(value.toString()) }
    var everFocused by remember { mutableStateOf(false) }
    LaunchedEffect(focused) {
        if (focused) {
            everFocused = true
            return@LaunchedEffect
        }
        if (!everFocused) return@LaunchedEffect
        // Focus just left: whatever was typed settles on the nearest value the range allows.
        val settled = text.toIntOrNull()?.coerceIn(range) ?: value
        if (settled != value) onChange(settled)
        text = settled.toString()
    }
    val ring by animateColorAsState(if (focused) c.ink.copy(alpha = 0.6f) else Color.Transparent, tween(160), label = "ring")
    val shape = RoundedCornerShape(Radii.field)
    Row(
        modifier
            .width(104.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .background(c.paperRaised, shape)
            .border(1.5.dp, ring, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically
    ) {
        BasicTextField(
            value = text,
            onValueChange = { raw ->
                val digits = raw.filter { it.isDigit() }.take(6)
                text = digits
                digits.toIntOrNull()?.takeIf { it in range }?.let { if (it != value) onChange(it) }
            },
            modifier = Modifier.weight(1f),
            enabled = enabled,
            textStyle = Murmur.type.title.copy(color = c.ink, textAlign = TextAlign.End),
            cursorBrush = SolidColor(c.ink),
            singleLine = true,
            interactionSource = interaction,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
        )
        Spacer(Modifier.width(6.dp))
        Text(unit, style = Murmur.type.labelSmall, color = c.inkSoft)
    }
}

/** A duration in whole seconds; see [UnitNumberControl]. */
@Composable
fun SecondsControl(
    value: Int,
    range: IntRange,
    onChange: (Int) -> Unit,
    label: String,
    enabled: Boolean = true,
    modifier: Modifier = Modifier
) = UnitNumberControl(value, range, onChange, unit = "s", label = label, enabled = enabled, modifier = modifier)
