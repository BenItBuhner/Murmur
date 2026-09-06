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
val murmurVersion = "0.2.0"

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
        buildConfigField(
            "String", "CLERK_PUBLISHABLE_KEY", "\"${envOrProp("MURMUR_CLERK_PUBLISHABLE_KEY")}\""
        )
        buildConfigField("String", "ACCOUNT_MODE", "\"${envOrProp("MURMUR_ACCOUNT_MODE")}\"")

        // GitHub repository (owner/name) whose Releases the in-app updater follows. CI passes the
        // building repository so forks update from their own releases.
        buildConfigField(
            "String", "UPDATE_REPO",
            "\"${envOrProp("MURMUR_UPDATE_REPO").ifBlank { "BenItBuhner/voxflow" }}\""
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
    // Must match the OkHttp the Clerk/Convex SDKs pull in (5.x), or MockWebServer fails to load.
    testImplementation("com.squareup.okhttp3:mockwebserver:5.4.0")
}
