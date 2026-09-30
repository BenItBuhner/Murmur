package app.murmur.android

import android.app.Application
import android.util.Log
import app.murmur.android.cloud.CloudBoot
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.cloud.CloudConfig

class MurmurApplication : Application() {
    /** What the build bakes in: which instance, and whether accounts are off, optional or required. */
    lateinit var cloudConfig: CloudConfig
        private set

    /** How the cloud came up this run: [CloudBoot.Off] for a local-only build, never a crash. */
    val cloud: CloudBoot get() = CloudBootstrap.state.value

    override fun onCreate() {
        super.onCreate()
        cloudConfig = CloudConfig.fromBuildConfig()
        // Nothing on the cloud path may take the app down: a failure leaves it in local mode and
        // the Account screen says so (see CloudBootstrap).
        when (val boot = CloudBootstrap.start(this, cloudConfig)) {
            CloudBoot.Off -> Log.i("Murmur", "accounts: off (local mode)")
            is CloudBoot.Ready ->
                Log.i("Murmur", "accounts: ${cloudConfig.accountMode.name.lowercase()} (${cloudConfig.convexUrl})")
            is CloudBoot.Failed ->
                Log.w("Murmur", "accounts: unavailable, ${boot.stage.name.lowercase()} failed; running in local mode")
        }
    }
}
