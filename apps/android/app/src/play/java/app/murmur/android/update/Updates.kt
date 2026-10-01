package app.murmur.android.update

import android.content.Context

/** The Google Play flavor's update layer behind the [Updater] seam: Play updates the app, Murmur never does. */
object Updates {
    @Suppress("UNUSED_PARAMETER")
    fun get(context: Context): Updater = NoUpdater
}
