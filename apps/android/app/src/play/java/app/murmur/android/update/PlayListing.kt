package app.murmur.android.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import app.murmur.android.BuildConfig

/** Murmur's page on Google Play, where this flavor's updates come from. */
object PlayListing {
    /** Opens the Play Store app on Murmur's listing (the web listing when the store app is missing). */
    val storeUri: Uri = Uri.parse("market://details?id=${BuildConfig.APPLICATION_ID}")
    val webUri: Uri = Uri.parse("https://play.google.com/store/apps/details?id=${BuildConfig.APPLICATION_ID}")

    fun open(context: Context) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, storeUri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            context.startActivity(Intent(Intent.ACTION_VIEW, webUri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
