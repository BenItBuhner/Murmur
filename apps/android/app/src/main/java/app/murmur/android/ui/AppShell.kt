package app.murmur.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.murmur.android.ui.components.ArrowLeft
import app.murmur.android.ui.components.Chevron
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.components.GlyphButton
import app.murmur.android.ui.components.GlyphIcon
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Elevation
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import kotlinx.coroutines.launch

/** What the button at the top left of a screen does: open the sections, or go back. */
sealed interface TopNav {
    data class Menu(val onOpen: () -> Unit) : TopNav
    data class Back(val onBack: () -> Unit) : TopNav
}

/** One destination in the drawer, grouped the way the desktop sidebar is. */
data class Section(
    val route: Route,
    val label: String,
    val glyph: Glyph,
    /** Starts a new group with this heading. */
    val group: String? = null,
    /** Something there needs the user (setup unfinished, an update ready). */
    val attention: Boolean = false
)

/**
 * The app's frame once set up: a drawer down the left with every section, opened by the button at
 * the top left of a top-level screen or by dragging in from the edge, and the back stack in front
 * of it. Picking a section closes the drawer and fades the section through; the back gesture then
 * leads home.
 */
@Composable
fun AppShell(
    navigator: Navigator,
    sections: List<Section>,
    footer: @Composable ColumnScope.(select: (Route) -> Unit) -> Unit = {},
    content: @Composable (entry: NavEntry, nav: TopNav) -> Unit
) {
    val c = Murmur.colors
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val open: () -> Unit = { scope.launch { drawer.open() } }
    val select: (Route) -> Unit = { route ->
        navigator.select(route)
        scope.launch { drawer.close() }
    }

    ModalNavigationDrawer(
        drawerState = drawer,
        // Only top-level screens open the drawer with a drag; a pushed screen keeps the edge for back.
        gesturesEnabled = drawer.isOpen || navigator.entry.topLevel,
        scrimColor = c.ink.copy(alpha = if (c.isDark) 0.5f else 0.28f),
        drawerContent = {
            Drawer(
                drawerState = drawer,
                sections = sections,
                current = navigator.current,
                onSelect = select,
                footer = { footer(select) }
            )
        }
    ) {
        NavHost(navigator) { entry ->
            val nav = if (entry.topLevel) TopNav.Menu(open) else TopNav.Back { navigator.back() }
            content(entry, nav)
        }
    }
}

/**
 * The sheet itself: wordmark, grouped sections, then whatever the caller puts at the bottom.
 * Material's sheet underneath gives it the predictive back gesture (it shrinks under the finger
 * and closes on release) and the "navigation menu" semantics; the surface is ours: a floating
 * layer at the sheet radius, lifted by elevation rather than edged.
 */
@Composable
private fun Drawer(
    drawerState: DrawerState,
    sections: List<Section>,
    current: Route,
    onSelect: (Route) -> Unit,
    footer: @Composable ColumnScope.() -> Unit
) {
    val c = Murmur.colors
    val shape = RoundedCornerShape(topEnd = Radii.sheet, bottomEnd = Radii.sheet)
    val width = (LocalConfiguration.current.screenWidthDp.dp - 64.dp).coerceIn(240.dp, 320.dp)
    ModalDrawerSheet(
        drawerState = drawerState,
        modifier = Modifier
            .width(width)
            .fillMaxHeight()
            .shadow(Elevation.floating, shape, clip = false)
            .testTag("drawer"),
        drawerShape = shape,
        drawerContainerColor = c.floating,
        drawerContentColor = c.ink,
        drawerTonalElevation = 0.dp
    ) {
        Row(
            Modifier.fillMaxWidth().height(64.dp).padding(horizontal = PageMargin),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Wordmark()
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp)
        ) {
            Spacer(Modifier.height(4.dp))
            for (section in sections) {
                if (section.group != null) {
                    Overline(section.group, Modifier.padding(start = 14.dp, top = 24.dp, bottom = 8.dp))
                }
                DrawerItem(section, selected = section.route == current, onClick = { onSelect(section.route) })
            }
            Spacer(Modifier.height(16.dp))
        }
        Column(Modifier.padding(horizontal = 12.dp, vertical = 12.dp), content = footer)
    }
}

@Composable
private fun DrawerItem(section: Section, selected: Boolean, onClick: () -> Unit) {
    val c = Murmur.colors
    val scheme = MaterialTheme.colorScheme
    val fill by animateColorAsState(
        if (selected) scheme.secondaryContainer else Color.Transparent,
        tween(220, easing = FastOutSlowInEasing),
        label = "fill"
    )
    val ink by animateColorAsState(if (selected) c.ink else c.inkSoft, tween(220), label = "ink")
    val glyph by animateColorAsState(if (selected) c.ember else c.inkSoft, tween(220), label = "glyph")
    Row(
        Modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(CircleShape)
            .background(fill)
            .selectable(selected, role = Role.Tab, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        GlyphIcon(section.glyph, glyph, size = 19.dp)
        Spacer(Modifier.width(14.dp))
        Text(
            section.label,
            style = Murmur.type.label,
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        if (section.attention) Dot(c.ember, size = 6.dp)
    }
}

/**
 * A line at the bottom of the drawer, like the desktop's status card: a dot, a label, a hint, and a
 * chevron when tapping it leads somewhere. A well sunk into the sheet, one radius step in from its
 * corner (sheet 24 - inset 12 = 12).
 */
@Composable
fun DrawerRow(
    label: String,
    hint: String?,
    modifier: Modifier = Modifier,
    dot: Color? = null,
    pulsing: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null
) {
    val c = Murmur.colors
    val shape = RoundedCornerShape(Radii.nested(Radii.sheet, Space.md))
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.paperRaised)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        } else if (dot != null) {
            Box(Modifier.size(8.dp), contentAlignment = Alignment.Center) { Dot(dot, size = 7.dp, pulsing = pulsing) }
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(label, style = Murmur.type.label, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!hint.isNullOrEmpty()) {
                Text(hint, style = Murmur.type.labelSmall, color = c.inkSoft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (onClick != null) {
            Spacer(Modifier.width(8.dp))
            Chevron(c.inkMuted, size = 14.dp)
        }
    }
}

/** The round button at the top left of a screen: three lines for the sections, an arrow for back. */
@Composable
fun TopNavButton(nav: TopNav, modifier: Modifier = Modifier) {
    val c = Murmur.colors
    when (nav) {
        is TopNav.Menu -> GlyphButton(
            onClick = nav.onOpen,
            modifier = modifier.semantics { contentDescription = "Sections" }
        ) { GlyphIcon(Glyph.MENU, c.ink, size = 22.dp) }
        is TopNav.Back -> GlyphButton(
            onClick = nav.onBack,
            modifier = modifier.semantics { contentDescription = "Back" }
        ) { ArrowLeft(c.ink) }
    }
}
