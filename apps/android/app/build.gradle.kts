import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.BuiltArtifactsLoader
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Seed provider defaults from the environment, mirroring the desktop app's
// MURMUR_BASE_URL / MURMUR_API_KEY / MURMUR_STT_MODEL / MURMUR_LLM_MODEL seeding.
// Keys never live in the repo; they are baked into local/dev builds only when set.
fun envOrProp(name: String): String =
    (System.getenv(name) ?: (project.findProperty(name) as String?) ?: "")

// Single source of truth for the Android version. Bump it with `npm run release -- <version>` from
// the repo root, which keeps it in sync with the desktop app and the README download links.
val murmurVersion = "0.6.5"

// Android needs a monotonically increasing integer versionCode. Derive it from the semver so nothing
// has to be bumped by hand: 1.2.3 -> 1_020_399, 1.2.3-beta.4 -> 1_020_304. Pre-releases sort below
// the final release they precede; minor and patch must stay below 100.
fun versionCodeFor(version: String): Int {
    val match = Regex("""^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$""").matchEntire(version)
        ?: error("murmurVersion must look like X.Y.Z or X.Y.Z-pre, got \"$version\"")
    val (major, minor, patch, pre) = match.destructured
    require(minor.toInt() < 100 && patch.toInt() < 100) {
        "minor and patch must be below 100 to fit the versionCode scheme: $version"
    }
    val release = if (pre.isEmpty()) 99
    else (Regex("""\d+""").findAll(pre).lastOrNull()?.value?.toIntOrNull() ?: 0).coerceIn(0, 98)
    return major.toInt() * 1_000_000 + minor.toInt() * 10_000 + patch.toInt() * 100 + release
}

// Release signing. CI decodes the keystore from repository secrets and passes these through the
// environment; locally use env vars or -P gradle properties with an absolute keystore path.
// Without a keystore, release builds fall back to the debug key so `assembleRelease` still yields
// an installable APK for testing. Debug-signed APKs cannot be updated in place by release-signed ones.
val releaseKeystore = envOrProp("MURMUR_KEYSTORE_FILE").takeIf { it.isNotBlank() }?.let { file(it) }
if (releaseKeystore != null) {
    require(releaseKeystore.exists()) { "MURMUR_KEYSTORE_FILE points to a missing file: $releaseKeystore" }
}

// Robolectric's Android runtime, resolved by Gradle with the other dependencies rather than fetched
// by Robolectric from Maven Central in the middle of the tests, where a dropped connection failed a
// whole test class: Gradle retries a transient network failure, and setup-gradle caches what it has
// resolved between CI runs. The tests read it offline from the synced directory. Every test runs on
// SDK 35; a test on another SDK needs that SDK's jar here, and a Robolectric upgrade may move the
// "-i" instrumentation suffix on (the tests then name the jar they are missing).
val robolectricRuntime: Configuration by configurations.creating { isTransitive = false }
val robolectricRuntimeDir = layout.buildDirectory.dir("robolectric-runtime")
val syncRobolectricRuntime by tasks.registering(Sync::class) {
    from(robolectricRuntime)
    into(robolectricRuntimeDir)
}

android {
    namespace = "app.murmur.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.murmur.android"
        minSdk = 26
        targetSdk = 35
        versionCode = versionCodeFor(murmurVersion)
        versionName = murmurVersion

        buildConfigField("String", "DEFAULT_BASE_URL", "\"${envOrProp("MURMUR_BASE_URL")}\"")
        buildConfigField("String", "DEFAULT_API_KEY", "\"${envOrProp("MURMUR_API_KEY")}\"")
        buildConfigField("String", "DEFAULT_STT_MODEL", "\"${envOrProp("MURMUR_STT_MODEL")}\"")
        buildConfigField("String", "DEFAULT_LLM_MODEL", "\"${envOrProp("MURMUR_LLM_MODEL")}\"")

        // Murmur cloud (accounts + sync). Same variables as the desktop build: leave them empty for
        // a local-only build, set both for a build against a Murmur instance. Accounts are required
        // by default when both are set; MURMUR_ACCOUNT_MODE=optional allows skipping.
        buildConfigField("String", "CONVEX_URL", "\"${envOrProp("MURMUR_CONVEX_URL")}\"")
        // HTTP actions URL of the deployment (the ".convex.site" one), home of the managed-model
        // gateway. Derived from CONVEX_URL for Convex Cloud and the local backend; set it only for
        // a self-hosted deployment on another host.
        buildConfigField("String", "CONVEX_SITE_URL", "\"${envOrProp("MURMUR_CONVEX_SITE_URL")}\"")
        buildConfigField(
            "String", "CLERK_PUBLISHABLE_KEY", "\"${envOrProp("MURMUR_CLERK_PUBLISHABLE_KEY")}\""
        )
        buildConfigField("String", "ACCOUNT_MODE", "\"${envOrProp("MURMUR_ACCOUNT_MODE")}\"")
    }

    // ---- Distribution flavors -------------------------------------------------------------------
    // One codebase, two ways to ship it. Only the update layer and the manifest differ:
    //  - direct (the default, what GitHub Releases carry): the in-app updater in src/direct checks
    //    the repository's releases, downloads the APK in the background and installs it when, and
    //    only when, the user taps Install on the Updates screen (REQUEST_INSTALL_PACKAGES).
    //  - play (Google Play): no updater at all. Play's Device and Network Abuse policy forbids an app
    //    updating itself outside Play, so src/play ships a no-op in its place, the manifest asks for
    //    no install permission, and the Updates screen points at the Play listing. verifyPlayReleaseApk
    //    opens the built APK and bundle and refuses one that carries any of the updater.
    // Build one with assembleDirectRelease / assemblePlayRelease (bundlePlayRelease for the AAB);
    // assembleRelease builds both.
    flavorDimensions += "distribution"
    productFlavors {
        create("direct") {
            dimension = "distribution"
            isDefault = true
            buildConfigField("String", "DISTRIBUTION", "\"direct\"")
            // GitHub repository (owner/name) whose Releases the in-app updater follows. CI passes
            // the building repository so forks update from their own releases.
            buildConfigField(
                "String", "UPDATE_REPO",
                "\"${envOrProp("MURMUR_UPDATE_REPO").ifBlank { "BenItBuhner/Murmur" }}\""
            )
        }
        create("play") {
            dimension = "distribution"
            buildConfigField("String", "DISTRIBUTION", "\"play\"")
        }
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = envOrProp("MURMUR_KEYSTORE_PASSWORD")
                keyAlias = envOrProp("MURMUR_KEY_ALIAS")
                keyPassword = envOrProp("MURMUR_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (releaseKeystore != null) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("MURMUR_KEYSTORE_FILE is not set: signing the release APK with the debug key.")
                signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric (TextInserterTest) needs the merged manifest and resources.
        unitTests.isIncludeAndroidResources = true
        // A failure prints its whole assertion (the state the flow ended in, not just the line),
        // so a CI log is enough to read it, and the app's logcat goes to the test's standard
        // output, which the JUnit report keeps (the console stays quiet).
        unitTests.all {
            it.systemProperty("robolectric.logging", "stdout")
            it.dependsOn(syncRobolectricRuntime)
            it.systemProperty("robolectric.offline", "true")
            it.systemProperty("robolectric.dependency.dir", robolectricRuntimeDir.get().asFile.absolutePath)
            // Robolectric screenshot tests (OverlayPillSpotScreenshotTest) drop their PNGs here.
            it.systemProperty(
                "murmur.screenshotDir",
                layout.buildDirectory.dir("reports/pill-screenshots").get().asFile.absolutePath
            )
            it.testLogging {
                events("failed", "skipped")
                exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
                showStackTraces = true
                showCauses = true
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Accounts (Clerk) and the synced backend (Convex). See packages/backend.
    implementation("com.clerk:clerk-android-api:1.1.5")
    implementation("com.clerk:clerk-android-ui:1.1.5")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("dev.convex:android-convexmobile:0.8.0@aar") {
        isTransitive = true
    }

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    // Runs the text-insertion strategy against a real EditText (TextInserterTest) and the whole
    // sample-clip dictation against an in-process STT endpoint (DictationFlowTest).
    testImplementation("org.robolectric:robolectric:4.15.1")
    robolectricRuntime("org.robolectric:android-all-instrumented:15-robolectric-12650502-i7")
    // Compose UI tests under Robolectric (BackStackHostTest drives the predictive back gesture).
    // ui-test-manifest declares the bare ComponentActivity createComposeRule() launches; it only
    // ends up in debug builds.
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    // Must match the OkHttp the Clerk/Convex SDKs pull in (5.x), or MockWebServer fails to load.
    testImplementation("com.squareup.okhttp3:mockwebserver:5.4.0")
}

// ---- Release artifact checks --------------------------------------------------------------------
// `verify<Variant>ReleaseApk` opens a release APK (and `verify<Variant>ReleaseBundle` the AAB) and
// refuses one that could not run the cloud path, or that does not match its distribution flavor:
//  - Cloud path: the Convex client is Rust behind UniFFI, loaded through JNA, so its native library
//    and JNA's must be in the artifact for arm64-v8a, and the classes JNA and the SDKs reach by name
//    must be in the dex (R8 would strip or rename them without keep rules). The baked cloud values
//    must be exactly the ones the build was given, production-shaped for a cloud release
//    (MURMUR_CLOUD_RELEASE=true), and nothing else that looks like a Clerk key or a Convex deployment
//    may be in the dex (a test fixture, a dev instance).
//  - Distribution: a `play` artifact carries no updater class beyond the seam the shared code talks
//    to, no PackageInstaller or GitHub reference in its dex, and asks for no install permission in
//    its manifest (Google Play's Device and Network Abuse policy); a `direct` artifact carries the
//    updater and both install permissions, so the two are provably different builds of one code base.
// `verifyReleaseApk` runs the APK check of every flavor. CI runs it with the Play bundle check after
// assembleRelease; the release workflow runs the direct check before anything ships. The gate and the
// SDKs themselves are exercised by the unit tests (AccountGateWithClerkTest).

/** What tells the two distribution flavors apart in a built artifact. */
object Distribution {
    const val DIRECT = "direct"
    const val PLAY = "play"
    val INSTALL_PERMISSIONS = listOf(
        "android.permission.REQUEST_INSTALL_PACKAGES",
        "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION"
    )
    /** The updater's package. In a Play build only the seam may be left of it. */
    const val UPDATER_PACKAGE = "Lapp/murmur/android/update/"
    val SEAM_CLASSES = setOf(
        "Lapp/murmur/android/update/Updater;",
        "Lapp/murmur/android/update/Updates;",
        "Lapp/murmur/android/update/NoUpdater;",
        "Lapp/murmur/android/update/PlayListing;"
    )
    /** What a direct build must define. */
    val UPDATER_CLASSES = listOf(
        "Lapp/murmur/android/update/UpdateManager;",
        "Lapp/murmur/android/update/UpdateResultReceiver;",
        "Lapp/murmur/android/update/UpdateSelection;"
    )
    /**
     * Framework types, endpoints and names only the updater reaches; none may be in a Play dex.
     * (PackageInstaller itself is also touched by Play Services' own update check,
     * GooglePlayServicesUtilLight, so the install session types stand for it.)
     */
    val UPDATER_STRINGS = listOf(
        "Landroid/content/pm/PackageInstaller\$Session;",
        "Landroid/content/pm/PackageInstaller\$SessionParams;",
        "canRequestPackageInstalls",
        "setRequireUserAction",
        "android.settings.MANAGE_UNKNOWN_APP_SOURCES",
        "https://api.github.com",
        "SHA256SUMS.txt",
        "-android.apk"
    )
    const val RESULT_RECEIVER = "app.murmur.android.update.UpdateResultReceiver"

    fun isSeam(descriptor: String): Boolean =
        descriptor in SEAM_CLASSES || SEAM_CLASSES.any { descriptor.startsWith(it.removeSuffix(";") + "$") }
}

/** Readers for the pieces of an APK or bundle the checks look at. */
object ArtifactReaders {
    val DEX_NAME = Regex("""(?:base/dex/)?classes\d*\.dex""")

    /** The string table and the defined class descriptors of one dex file (format: source.android.com/docs/core/runtime/dex-format). */
    fun readDex(dex: ByteArray): Pair<List<String>, Set<String>> {
        val buf = ByteBuffer.wrap(dex).order(ByteOrder.LITTLE_ENDIAN)
        require(dex.size > 0x70 && dex[0] == 'd'.code.toByte() && dex[1] == 'e'.code.toByte() && dex[2] == 'x'.code.toByte()) { "not a dex file" }
        val stringIdsSize = buf.getInt(0x38)
        val stringIdsOff = buf.getInt(0x3C)
        val typeIdsOff = buf.getInt(0x44)
        val classDefsSize = buf.getInt(0x60)
        val classDefsOff = buf.getInt(0x64)
        val strings = ArrayList<String>(stringIdsSize)
        for (i in 0 until stringIdsSize) {
            var p = buf.getInt(stringIdsOff + i * 4)
            // string_data_item: uleb128 utf16 length, then MUTF-8 bytes ending in NUL.
            while (dex[p].toInt() and 0x80 != 0) p++
            p++
            val start = p
            while (dex[p] != 0.toByte()) p++
            strings += String(dex, start, p - start, Charsets.UTF_8)
        }
        val classes = HashSet<String>(classDefsSize)
        for (i in 0 until classDefsSize) {
            val typeIdx = buf.getInt(classDefsOff + i * 32)
            classes += strings[buf.getInt(typeIdsOff + typeIdx * 4)]
        }
        return strings to classes
    }

    /**
     * The string pool of a compiled (binary) AndroidManifest.xml, as an APK carries it: every tag,
     * attribute name and attribute value, so the permissions asked for and the components declared
     * are all in it (format: ResXMLTree_header, then a ResStringPool chunk; UTF-8 or UTF-16).
     */
    fun readBinaryXmlStrings(xml: ByteArray): List<String> {
        val buf = ByteBuffer.wrap(xml).order(ByteOrder.LITTLE_ENDIAN)
        require(xml.size > 36 && buf.getShort(0).toInt() and 0xFFFF == 0x0003) { "not a binary XML" }
        val pool = buf.getShort(2).toInt() and 0xFFFF
        require(buf.getShort(pool).toInt() and 0xFFFF == 0x0001) { "no string pool after the XML header" }
        val headerSize = buf.getShort(pool + 2).toInt() and 0xFFFF
        val count = buf.getInt(pool + 8)
        val utf8 = buf.getInt(pool + 16) and (1 shl 8) != 0
        val stringsStart = buf.getInt(pool + 20)
        val out = ArrayList<String>(count)
        for (i in 0 until count) {
            var p = pool + stringsStart + buf.getInt(pool + headerSize + i * 4)
            if (utf8) {
                // Character count then byte count, each one byte or (high bit set) two.
                if (xml[p].toInt() and 0x80 != 0) p += 2 else p += 1
                var len = xml[p].toInt() and 0xFF
                p++
                if (len and 0x80 != 0) {
                    len = ((len and 0x7F) shl 8) or (xml[p].toInt() and 0xFF)
                    p++
                }
                out += String(xml, p, len, Charsets.UTF_8)
            } else {
                var len = buf.getShort(p).toInt() and 0xFFFF
                p += 2
                if (len and 0x8000 != 0) {
                    len = ((len and 0x7FFF) shl 16) or (buf.getShort(p).toInt() and 0xFFFF)
                    p += 2
                }
                out += String(xml, p, len * 2, Charsets.UTF_16LE)
            }
        }
        return out
    }
}

/** Everything the checks read out of one artifact, APK or bundle. */
class ArtifactContents(
    val dexEntries: List<Pair<String, Int>>,
    val strings: Set<String>,
    val classes: Set<String>,
    /** Strings of the manifest: the binary XML's pool (APK) or every readable run of the proto manifest (bundle). */
    val manifestStrings: List<String>,
    val nativeLibSizes: Map<String, Long>
) {
    fun manifestHas(needle: String): Boolean = manifestStrings.any { it.contains(needle) }

    companion object {
        fun read(zip: ZipFile, bundle: Boolean, abi: String, nativeLibs: List<String>): ArtifactContents {
            val prefix = if (bundle) "base/" else ""
            val dexEntries = mutableListOf<Pair<String, Int>>()
            val strings = HashSet<String>()
            val classes = HashSet<String>()
            for (entry in zip.entries().asSequence().filter { ArtifactReaders.DEX_NAME.matches(it.name) }.sortedBy { it.name }) {
                val (dexStrings, dexClasses) = ArtifactReaders.readDex(zip.getInputStream(entry).use { it.readBytes() })
                strings += dexStrings
                classes += dexClasses
                dexEntries += entry.name to dexClasses.size
            }
            val manifestEntry = zip.getEntry("${prefix}manifest/AndroidManifest.xml".takeIf { bundle } ?: "AndroidManifest.xml")
                ?: throw GradleException("no AndroidManifest.xml in ${zip.name}")
            val manifestBytes = zip.getInputStream(manifestEntry).use { it.readBytes() }
            val manifestStrings = if (bundle) {
                // aapt2's protobuf manifest keeps names and values as plain UTF-8 runs.
                Regex("""[\x20-\x7E]{4,}""").findAll(String(manifestBytes, Charsets.ISO_8859_1)).map { it.value }.toList()
            } else {
                ArtifactReaders.readBinaryXmlStrings(manifestBytes)
            }
            val libs = nativeLibs.associateWith { lib -> zip.getEntry("${prefix}lib/$abi/$lib")?.size ?: -1L }
            return ArtifactContents(dexEntries, strings, classes, manifestStrings, libs)
        }
    }
}

/** The checks shared by the APK and the bundle task; [problems] collects what is wrong, [lines] the report. */
abstract class VerifyReleaseArtifact : DefaultTask() {
    @get:Internal
    abstract val builtArtifactsLoader: Property<BuiltArtifactsLoader>

    /** The values the build baked into BuildConfig (raw, as given). */
    @get:Input
    abstract val convexUrl: Property<String>

    @get:Input
    abstract val convexSiteUrl: Property<String>

    @get:Input
    abstract val clerkPublishableKey: Property<String>

    @get:Input
    abstract val accountMode: Property<String>

    /** MURMUR_CLOUD_RELEASE was "true": the artifact must carry a production instance. */
    @get:Input
    abstract val cloudRelease: Property<Boolean>

    /** The variant's distribution flavor: [Distribution.DIRECT] or [Distribution.PLAY]. */
    @get:Input
    abstract val distribution: Property<String>

    @get:OutputFile
    abstract val report: RegularFileProperty

    protected fun finish(subject: String, lines: List<String>, problems: List<String>) {
        val text = lines.joinToString("\n") + (if (problems.isEmpty()) "\n\nOK" else "\n\nPROBLEMS:\n - " + problems.joinToString("\n - ")) + "\n"
        report.get().asFile.also { it.parentFile.mkdirs() }.writeText(text)
        if (problems.isNotEmpty()) throw GradleException("$subject is not fit to ship:\n - " + problems.joinToString("\n - ") + "\n\n$text")
        logger.lifecycle(text)
    }

    protected fun check(file: File, bundle: Boolean, lines: MutableList<String>, problems: MutableList<String>) {
        val contents = ZipFile(file).use { ArtifactContents.read(it, bundle, ABI, NATIVE_LIBS) }
        for ((lib, size) in contents.nativeLibSizes) {
            if (size <= 0) problems += "lib/$ABI/$lib is missing" else lines += "  lib/$ABI/$lib: $size bytes"
        }
        if (contents.dexEntries.isEmpty()) problems += "no classes.dex"
        for ((name, count) in contents.dexEntries) lines += "  $name: $count classes"
        for (descriptor in REQUIRED_CLASSES) {
            if (descriptor !in contents.classes) problems += "class $descriptor is not defined in the dex (stripped or renamed?)"
        }
        checkBakedValues(contents.strings, lines, problems)
        checkDistribution(contents, lines, problems)
    }

    private fun checkBakedValues(strings: Set<String>, lines: MutableList<String>, problems: MutableList<String>) {
        val url = convexUrl.get()
        val site = convexSiteUrl.get()
        val key = clerkPublishableKey.get()
        val cloud = url.isNotBlank() || key.isNotBlank()
        lines += if (cloud) "  cloud: $url (site: ${site.ifBlank { "derived" }}), $key, accounts ${accountMode.get().ifBlank { "required" }}"
        else "  cloud: none (local-only build)"
        if (cloudRelease.get()) {
            if (url.isBlank() || key.isBlank()) problems += "MURMUR_CLOUD_RELEASE is true but MURMUR_CONVEX_URL / MURMUR_CLERK_PUBLISHABLE_KEY are not both set: this would ship as a local-only build"
            if (key.isNotBlank() && !key.startsWith("pk_live_")) problems += "a cloud release needs a production Clerk key (pk_live_…), got ${key.take(8)}…"
            if (url.isNotBlank() && !PRODUCTION_URL.matches(url.trim())) problems += "a cloud release needs a public https Convex URL, got $url"
        }
        if (url.isNotBlank() && url !in strings) problems += "MURMUR_CONVEX_URL ($url) is not baked into the dex"
        if (key.isNotBlank() && key !in strings) problems += "MURMUR_CLERK_PUBLISHABLE_KEY is not baked into the dex"
        if (site.isNotBlank() && site !in strings) problems += "MURMUR_CONVEX_SITE_URL ($site) is not baked into the dex"
        // On Convex Cloud the client URL and the HTTP-actions URL name the same deployment.
        val cloudDeployment = CONVEX_CLOUD_HOST.find(url.trim())?.groupValues?.get(1)
        val siteDeployment = CONVEX_SITE_HOST.find(site.trim())?.groupValues?.get(1)
        if (cloudDeployment != null && siteDeployment != null && cloudDeployment != siteDeployment) {
            problems += "MURMUR_CONVEX_SITE_URL names deployment $siteDeployment but MURMUR_CONVEX_URL names $cloudDeployment"
        }
        val allowedUrls = setOf(url, site).filter { it.isNotBlank() }
        for (s in strings) {
            if (CLERK_KEY.matches(s) && s != key) problems += "a Clerk key other than the build's is in the dex: ${s.take(12)}…"
            if (CONVEX_URL.containsMatchIn(s) && s !in allowedUrls) problems += "a Convex deployment other than the build's is in the dex: $s"
        }
    }

    /** A Play artifact carries none of the updater; a direct one carries all of it. */
    private fun checkDistribution(contents: ArtifactContents, lines: MutableList<String>, problems: MutableList<String>) {
        val flavor = distribution.get()
        val updaterClasses = contents.classes.filter { it.startsWith(Distribution.UPDATER_PACKAGE) }.sorted()
        val permissions = Distribution.INSTALL_PERMISSIONS.filter { contents.manifestHas(it) }
        lines += "  distribution: $flavor, ${updaterClasses.size} classes under ${Distribution.UPDATER_PACKAGE}, install permissions: ${permissions.ifEmpty { listOf("none") }.joinToString()}"
        when (flavor) {
            Distribution.PLAY -> {
                for (cls in updaterClasses) {
                    if (!Distribution.isSeam(cls)) problems += "Play build carries updater class $cls"
                }
                for (s in Distribution.UPDATER_STRINGS) {
                    if (s in contents.strings) problems += "Play build's dex references the updater: \"$s\""
                }
                for (p in permissions) problems += "Play build's manifest asks for $p"
                if (contents.manifestHas(Distribution.RESULT_RECEIVER)) problems += "Play build's manifest declares ${Distribution.RESULT_RECEIVER}"
            }
            Distribution.DIRECT -> {
                for (cls in Distribution.UPDATER_CLASSES) {
                    if (cls !in contents.classes) problems += "direct build lacks updater class $cls"
                }
                for (p in Distribution.INSTALL_PERMISSIONS) {
                    if (p !in permissions) problems += "direct build's manifest lacks $p"
                }
                if (!contents.manifestHas(Distribution.RESULT_RECEIVER)) problems += "direct build's manifest lacks ${Distribution.RESULT_RECEIVER}"
            }
            else -> problems += "unknown distribution flavor \"$flavor\""
        }
    }

    companion object {
        const val ABI = "arm64-v8a"
        val NATIVE_LIBS = listOf("libconvexmobile.so", "libjnidispatch.so")
        /** What JNA, UniFFI and the SDKs reach by name or by reflection, plus the app's own cloud path. */
        val REQUIRED_CLASSES = listOf(
            "Lcom/sun/jna/Native;",
            "Lcom/sun/jna/Structure;",
            "Ldev/convex/android/UniffiLib;",
            "Ldev/convex/android/MobileConvexClient;",
            "Ldev/convex/android/ConvexClientWithAuth;",
            "Lcom/clerk/api/Clerk;",
            "Lcom/clerk/ui/auth/AuthViewKt;",
            "Lkotlinx/serialization/json/Json;",
            "Lapp/murmur/android/MurmurApplication;",
            "Lapp/murmur/android/cloud/CloudBootstrap;",
            "Lapp/murmur/android/cloud/CloudSync;",
            "Lapp/murmur/android/ui/AccountGateScreenKt;"
        )
        val CLERK_KEY = Regex("""pk_(live|test)_[A-Za-z0-9+/=]{8,}""")
        val CONVEX_URL = Regex("""^https?://[^/\s]+\.convex\.(cloud|site)(/|$)""")
        val CONVEX_CLOUD_HOST = Regex("""^https://([a-z0-9-]+)\.convex\.cloud/?$""")
        val CONVEX_SITE_HOST = Regex("""^https://([a-z0-9-]+)\.convex\.site/?$""")
        /** Public https, no loopback or emulator host: what a production deployment looks like. */
        val PRODUCTION_URL = Regex("""^https://(?!(127\.0\.0\.1|localhost|0\.0\.0\.0|10\.0\.2\.2|\[::1\])(:|/|$))[A-Za-z0-9.-]+(:\d+)?/?$""")
    }
}

abstract class VerifyReleaseApk : VerifyReleaseArtifact() {
    @get:InputFiles
    abstract val apkDir: DirectoryProperty

    @TaskAction
    fun verify() {
        val built = builtArtifactsLoader.get().load(apkDir.get())
            ?: throw GradleException("No release APK to check in ${apkDir.get().asFile}")
        val lines = mutableListOf<String>()
        val problems = mutableListOf<String>()
        for (artifact in built.elements) {
            val apk = File(artifact.outputFile)
            lines += "${apk.name} (${apk.length() / 1024} KiB, versionCode ${artifact.versionCode}, versionName ${artifact.versionName})"
            check(apk, bundle = false, lines, problems)
        }
        finish("The ${distribution.get()} release APK", lines, problems)
    }
}

abstract class VerifyReleaseBundle : VerifyReleaseArtifact() {
    @get:InputFile
    abstract val bundle: RegularFileProperty

    @TaskAction
    fun verify() {
        val aab = bundle.get().asFile
        val lines = mutableListOf("${aab.name} (${aab.length() / 1024} KiB)")
        val problems = mutableListOf<String>()
        check(aab, bundle = true, lines, problems)
        finish("The ${distribution.get()} release bundle", lines, problems)
    }
}

val verifyReleaseApk by tasks.registering {
    group = "verification"
    description = "Checks the release APK of every distribution flavor (cloud path, and what the flavor must and must not carry)."
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        val flavor = variant.flavorName ?: error("release variant ${variant.name} has no distribution flavor")
        val capitalized = variant.name.replaceFirstChar { it.uppercase() }
        fun VerifyReleaseArtifact.configureInputs() {
            group = "verification"
            builtArtifactsLoader.set(variant.artifacts.getBuiltArtifactsLoader())
            convexUrl.set(envOrProp("MURMUR_CONVEX_URL"))
            convexSiteUrl.set(envOrProp("MURMUR_CONVEX_SITE_URL"))
            clerkPublishableKey.set(envOrProp("MURMUR_CLERK_PUBLISHABLE_KEY"))
            accountMode.set(envOrProp("MURMUR_ACCOUNT_MODE"))
            cloudRelease.set(envOrProp("MURMUR_CLOUD_RELEASE").trim().equals("true", ignoreCase = true))
            distribution.set(flavor)
        }
        val apkCheck = tasks.register<VerifyReleaseApk>("verify${capitalized}Apk") {
            configureInputs()
            description = "Checks that the ${variant.name} APK carries what the cloud path needs and matches the $flavor distribution."
            apkDir.set(variant.artifacts.get(SingleArtifact.APK))
            report.set(layout.buildDirectory.file("reports/apk/${variant.name}-apk-check.txt"))
        }
        tasks.register<VerifyReleaseBundle>("verify${capitalized}Bundle") {
            configureInputs()
            description = "Checks that the ${variant.name} app bundle carries what the cloud path needs and matches the $flavor distribution."
            bundle.set(variant.artifacts.get(SingleArtifact.BUNDLE))
            report.set(layout.buildDirectory.file("reports/apk/${variant.name}-bundle-check.txt"))
        }
        verifyReleaseApk.configure { dependsOn(apkCheck) }
    }
}
