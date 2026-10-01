package app.murmur.android.update

import android.content.Context

/** The direct (GitHub Releases) flavor's update layer: the in-app updater behind the [Updater] seam. */
object Updates {
    fun get(context: Context): Updater = UpdateManager.get(context)
}
