package app.murmur.android.ui

import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import app.murmur.android.keyboard.WidthClass
import app.murmur.android.ui.theme.Layout

/** Material's window width class for the window this composition is in. */
val windowWidthClass: WidthClass
    @Composable @ReadOnlyComposable get() = WidthClass.of(LocalConfiguration.current.screenWidthDp)

/**
 * A screen's content column on any width: it fills a phone, and on a tablet it is capped at
 * [Layout.contentMaxWidth] and centred, so lines stay readable and controls stay reachable. Apply
 * after `fillMaxWidth()` on the column that holds the screen's content.
 */
fun Modifier.contentWidth(): Modifier =
    wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = Layout.contentMaxWidth)
