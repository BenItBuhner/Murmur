package app.murmur.android.cloud

import app.murmur.android.BuildConfig
import java.net.URI

/**
 * How the build treats accounts, mirroring the desktop app (apps/desktop/src/main/cloud/config.ts):
 * OFF is fully local, OPTIONAL offers sign-in with a skip, REQUIRED (the production default when a
 * Convex URL and Clerk key are baked in) gates the app behind sign-up.
 */
enum class AccountMode { OFF, OPTIONAL, REQUIRED }

data class CloudConfig(
    val accountMode: AccountMode,
    val convexUrl: String,
    val clerkPublishableKey: String,
    /**
     * Origin of the deployment's HTTP actions (`https://<name>.convex.site`), where the managed
     * inference gateway lives. Empty when it cannot be derived and was not given explicitly.
     */
    val convexSiteUrl: String = ""
) {
    val enabled: Boolean get() = accountMode != AccountMode.OFF

    /** The build can offer the instance's managed models at all. */
    val managedModels: Boolean get() = enabled && convexSiteUrl.isNotEmpty()

    companion object {
        /** Name of the Clerk JWT template that mints Convex tokens. */
        const val JWT_TEMPLATE = "convex"

        val OFF = CloudConfig(AccountMode.OFF, "", "")

        fun fromBuildConfig(): CloudConfig =
            resolve(
                BuildConfig.CONVEX_URL,
                BuildConfig.CLERK_PUBLISHABLE_KEY,
                BuildConfig.ACCOUNT_MODE,
                BuildConfig.CONVEX_SITE_URL
            )

        fun resolve(
            convexUrl: String,
            clerkPublishableKey: String,
            requestedMode: String,
            convexSiteUrl: String = ""
        ): CloudConfig {
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
            val explicitSite = convexSiteUrl.trim().trimEnd('/')
            val site = if (explicitSite.startsWith("https://") || explicitSite.startsWith("http://")) explicitSite
            else deriveSiteUrl(url) ?: ""
            return CloudConfig(accountMode, url, key, site)
        }

        /**
         * Where a deployment serves HTTP actions, from its client URL: Convex Cloud pairs
         * `<name>.convex.cloud` with `<name>.convex.site`; the local backend serves them one port up
         * (3210 -> 3211). Anything else needs MURMUR_CONVEX_SITE_URL.
         */
        fun deriveSiteUrl(convexUrl: String): String? {
            val uri = try {
                URI(convexUrl.trim())
            } catch (_: Exception) {
                return null
            }
            val host = uri.host ?: return null
            val scheme = uri.scheme ?: return null
            if (host.endsWith(".convex.cloud", ignoreCase = true)) {
                return "$scheme://${host.substring(0, host.length - ".convex.cloud".length)}.convex.site"
            }
            if (uri.port in 1..65533) return "$scheme://$host:${uri.port + 1}"
            return null
        }
    }
}
