package app.murmur.android.cloud

import app.murmur.android.BuildConfig

/**
 * How the build treats accounts, mirroring the desktop app (apps/desktop/src/main/cloud/config.ts):
 * OFF is fully local, OPTIONAL offers sign-in with a skip, REQUIRED (the production default when a
 * Convex URL and Clerk key are baked in) gates the app behind sign-up.
 */
enum class AccountMode { OFF, OPTIONAL, REQUIRED }

data class CloudConfig(
    val accountMode: AccountMode,
    val convexUrl: String,
    val clerkPublishableKey: String
) {
    val enabled: Boolean get() = accountMode != AccountMode.OFF

    companion object {
        /** Name of the Clerk JWT template that mints Convex tokens. */
        const val JWT_TEMPLATE = "convex"

        val OFF = CloudConfig(AccountMode.OFF, "", "")

        fun fromBuildConfig(): CloudConfig =
            resolve(BuildConfig.CONVEX_URL, BuildConfig.CLERK_PUBLISHABLE_KEY, BuildConfig.ACCOUNT_MODE)

        fun resolve(convexUrl: String, clerkPublishableKey: String, requestedMode: String): CloudConfig {
            val mode = requestedMode.trim().lowercase()
            if (mode == "off") return OFF
            val url = convexUrl.trim().trimEnd('/')
            val key = clerkPublishableKey.trim()
            if (!url.startsWith("https://") && !url.startsWith("http://")) return OFF
            if (!key.matches(Regex("^pk_(test|live)_[A-Za-z0-9+/=]+$"))) return OFF
            val accountMode = when (mode) {
                "optional" -> AccountMode.OPTIONAL
                else -> AccountMode.REQUIRED
            }
            return CloudConfig(accountMode, url, key)
        }
    }
}
