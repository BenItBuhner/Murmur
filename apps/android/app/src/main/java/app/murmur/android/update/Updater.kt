package app.murmur.android.update

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow

/**
 * The seam between the app and its update layer; everything the shared code (MainActivity, Home,
 * the accessibility service) needs to know about updates. Each distribution flavor supplies the
 * implementation behind `Updates.get`:
 *
 *  - `direct` (GitHub Releases) backs it with `UpdateManager`, which checks and downloads on its
 *    own but hands a build to the package installer only when the user taps Install on the
 *    Updates screen.
 *  - `play` (Google Play) backs it with `NoUpdater`: Play keeps the app current, and Play's
 *    Device and Network Abuse policy forbids an app updating itself any other way, so none of the
 *    updater is compiled into that variant.
 */
interface Updater {
    /**
     * Version of a verified download waiting for the user to tap Install on the Updates screen, or
     * null. Drives the drawer's attention dot and the card on Home; nothing installs on its own.
     */
    val readyVersion: StateFlow<String?>

    /** The app came to the front (MainActivity.onResume). */
    fun onAppVisible()

    /** The app left the front (MainActivity.onPause). */
    fun onAppHidden()

    /** Periodic checks for as long as [scope] lives (the accessibility service, the app's only long-lived part). */
    fun startBackgroundChecks(scope: CoroutineScope)
}
