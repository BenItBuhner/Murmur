package app.murmur.android.update

/**
 * Minimal semver precedence, the same rules as apps/desktop/src/core/update/version.ts. Release
 * tags are `vX.Y.Z` or `vX.Y.Z-pre.N` (scripts/release.mjs never emits build metadata).
 */
data class Semver(val major: Int, val minor: Int, val patch: Int, val prerelease: List<String>) :
    Comparable<Semver> {

    val isPrerelease: Boolean get() = prerelease.isNotEmpty()

    override fun compareTo(other: Semver): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        // A release without a pre-release tag is newer than the same version with one.
        if (prerelease.isEmpty() && other.prerelease.isEmpty()) return 0
        if (prerelease.isEmpty()) return 1
        if (other.prerelease.isEmpty()) return -1
        for (i in 0 until minOf(prerelease.size, other.prerelease.size)) {
            val c = compareIdentifiers(prerelease[i], other.prerelease[i])
            if (c != 0) return c
        }
        return prerelease.size.compareTo(other.prerelease.size)
    }

    override fun toString(): String =
        "$major.$minor.$patch" + if (prerelease.isEmpty()) "" else "-" + prerelease.joinToString(".")

    companion object {
        private val RE = Regex(
            """^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)""" +
                """(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?""" +
                """(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$"""
        )

        /** Parse `1.2.3`, `v1.2.3` or `1.2.3-beta.4`; returns null for anything else. */
        fun parse(input: String): Semver? {
            val m = RE.matchEntire(input.trim()) ?: return null
            val pre = m.groupValues[4]
            return Semver(
                m.groupValues[1].toInt(),
                m.groupValues[2].toInt(),
                m.groupValues[3].toInt(),
                if (pre.isEmpty()) emptyList() else pre.split('.')
            )
        }

        /** Negative when `a` is older than `b`. Unparseable input sorts below every valid version. */
        fun compare(a: String, b: String): Int {
            val pa = parse(a)
            val pb = parse(b)
            if (pa == null && pb == null) return 0
            if (pa == null) return -1
            if (pb == null) return 1
            return pa.compareTo(pb)
        }

        private fun compareIdentifiers(a: String, b: String): Int {
            val aNum = a.all { it.isDigit() }
            val bNum = b.all { it.isDigit() }
            return when {
                aNum && bNum -> a.toBigInteger().compareTo(b.toBigInteger())
                // Numeric identifiers always have lower precedence than alphanumeric ones.
                aNum -> -1
                bNum -> 1
                else -> a.compareTo(b)
            }
        }
    }
}
