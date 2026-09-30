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
val murmurVersion = "0.6.3"

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

        // GitHub repository (owner/name) whose Releases the in-app updater follows. CI passes the
        // building repository so forks update from their own releases.
        buildConfigField(
            "String", "UPDATE_REPO",
            "\"${envOrProp("MURMUR_UPDATE_REPO").ifBlank { "BenItBuhner/Murmur" }}\""
        )
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

// ---- Release APK check --------------------------------------------------------------------------
// `verifyReleaseApk` opens the release APK and refuses one that could not run the cloud path: the
// Convex client is Rust behind UniFFI, loaded through JNA, so its native library and JNA's must be in
// the APK for arm64-v8a, and the classes JNA and the SDKs reach by name must be in the dex (R8 would
// strip or rename them without keep rules). The baked cloud values must be exactly the ones the
// build was given, production-shaped for a cloud release (MURMUR_CLOUD_RELEASE=true), and nothing
// else that looks like a Clerk key or a Convex deployment may be in the dex (a test fixture, a dev
// instance). CI and the release workflow run it right after assembleRelease, before anything ships.
// The gate and the SDKs themselves are exercised by the unit tests (AccountGateWithClerkTest).
abstract class VerifyReleaseApk : DefaultTask() {
    @get:InputFiles
    abstract val apkDir: DirectoryProperty

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

    /** MURMUR_CLOUD_RELEASE was "true": the APK must carry a production instance. */
    @get:Input
    abstract val cloudRelease: Property<Boolean>

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val built = builtArtifactsLoader.get().load(apkDir.get())
            ?: throw GradleException("No release APK to check in ${apkDir.get().asFile}")
        val lines = mutableListOf<String>()
        val problems = mutableListOf<String>()
        for (artifact in built.elements) {
            val apk = File(artifact.outputFile)
            lines += "${apk.name} (${apk.length() / 1024} KiB, versionCode ${artifact.versionCode}, versionName ${artifact.versionName})"
            checkApk(apk, lines, problems)
        }
        val text = lines.joinToString("\n") + (if (problems.isEmpty()) "\n\nOK" else "\n\nPROBLEMS:\n - " + problems.joinToString("\n - ")) + "\n"
        report.get().asFile.also { it.parentFile.mkdirs() }.writeText(text)
        if (problems.isNotEmpty()) throw GradleException("The release APK would not run the cloud path:\n - " + problems.joinToString("\n - ") + "\n\n$text")
        logger.lifecycle(text)
    }

    private fun checkApk(apk: File, lines: MutableList<String>, problems: MutableList<String>) {
        ZipFile(apk).use { zip ->
            for (lib in NATIVE_LIBS) {
                val entry = zip.getEntry("lib/$ABI/$lib")
                if (entry == null || entry.size <= 0) problems += "lib/$ABI/$lib is missing"
                else lines += "  lib/$ABI/$lib: ${entry.size} bytes"
            }
            val dexEntries = zip.entries().asSequence().filter { DEX_NAME.matches(it.name) }.sortedBy { it.name }.toList()
            if (dexEntries.isEmpty()) problems += "no classes.dex"
            val classes = HashSet<String>()
            val strings = HashSet<String>()
            for (entry in dexEntries) {
                val dex = zip.getInputStream(entry).use { it.readBytes() }
                val (dexStrings, dexClasses) = readDex(dex)
                strings += dexStrings
                classes += dexClasses
                lines += "  ${entry.name}: ${dexClasses.size} classes, ${dexStrings.size} strings"
            }
            for (descriptor in REQUIRED_CLASSES) {
                if (descriptor !in classes) problems += "class $descriptor is not defined in the dex (stripped or renamed?)"
            }
            checkBakedValues(strings, lines, problems)
        }
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

    /** The string table and the defined class descriptors of one dex file (format: source.android.com/docs/core/runtime/dex-format). */
    private fun readDex(dex: ByteArray): Pair<List<String>, Set<String>> {
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

    companion object {
        const val ABI = "arm64-v8a"
        val NATIVE_LIBS = listOf("libconvexmobile.so", "libjnidispatch.so")
        val DEX_NAME = Regex("""classes\d*\.dex""")
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

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        tasks.register<VerifyReleaseApk>("verify${variant.name.replaceFirstChar { it.uppercase() }}Apk") {
            group = "verification"
            description = "Checks that the ${variant.name} APK carries what the cloud path needs (native libs, classes, baked instance)."
            apkDir.set(variant.artifacts.get(SingleArtifact.APK))
            builtArtifactsLoader.set(variant.artifacts.getBuiltArtifactsLoader())
            convexUrl.set(envOrProp("MURMUR_CONVEX_URL"))
            convexSiteUrl.set(envOrProp("MURMUR_CONVEX_SITE_URL"))
            clerkPublishableKey.set(envOrProp("MURMUR_CLERK_PUBLISHABLE_KEY"))
            accountMode.set(envOrProp("MURMUR_ACCOUNT_MODE"))
            cloudRelease.set(envOrProp("MURMUR_CLOUD_RELEASE").trim().equals("true", ignoreCase = true))
            report.set(layout.buildDirectory.file("reports/apk/${variant.name}-apk-check.txt"))
        }
    }
}
