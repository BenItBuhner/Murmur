package app.murmur.android

import android.app.Application
import android.util.Log
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.settings.SettingsStore
import com.clerk.api.Clerk

class MurmurApplication : Application() {
    lateinit var cloudConfig: CloudConfig
        private set

    override fun onCreate() {
        super.onCreate()
        cloudConfig = CloudConfig.fromBuildConfig()
        if (cloudConfig.enabled) {
            Clerk.initialize(this, publishableKey = cloudConfig.clerkPublishableKey)
            CloudSync.init(this, cloudConfig, SettingsStore.get(this))
            Log.i("Murmur", "accounts: ${cloudConfig.accountMode.name.lowercase()} (${cloudConfig.convexUrl})")
        } else {
            Log.i("Murmur", "accounts: off (local mode)")
        }
    }
}
