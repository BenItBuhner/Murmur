package app.murmur.android

/**
 * Which app this build is: Murmur, or Ephemeris (built with -Pbrand=ephemeris, see app/build.gradle.kts).
 * The two share every feature; Ephemeris adds the Ember Dots pill, its warm dark look, and context
 * capture that syncs to the Ephemeris tables of the same Murmur account.
 */
object Brand {
    val isEphemeris: Boolean = BuildConfig.BRAND == "ephemeris"
    /** The product name as the user reads it. */
    val name: String = if (isEphemeris) "Ephemeris" else "Murmur"
}
