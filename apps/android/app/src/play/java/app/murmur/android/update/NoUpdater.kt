package app.murmur.android.update

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The Google Play flavor's update layer: nothing. Play delivers updates, and its Device and
 * Network Abuse policy forbids an app replacing itself any other way, so this build neither
 * checks GitHub, nor downloads an APK, nor touches the package installer; none of that code is
 * compiled into it (verifyPlayReleaseApk checks the built APK and bundle for that).
 */
object NoUpdater : Updater {
    override val readyVersion: StateFlow<String?> = MutableStateFlow(null)

    override fun onAppVisible() = Unit

    override fun onAppHidden() = Unit

    override fun startBackgroundChecks(scope: CoroutineScope) = Unit
}
