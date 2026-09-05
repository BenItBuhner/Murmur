plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Seed provider defaults from the environment, mirroring the desktop app's
// MURMUR_BASE_URL / MURMUR_API_KEY / MURMUR_STT_MODEL / MURMUR_LLM_MODEL seeding.
// Keys never live in the repo; they are baked into local/dev builds only when set.
fun envOrProp(name: String): String =
    (System.getenv(name) ?: (project.findProperty(name) as String?) ?: "")

// Single source of truth for the Android version. Bump it with `npm run release -- <version>` from
// the repo root, which keeps it in sync with the desktop app and the README download links.
val murmurVersion = "0.1.0"

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
    compileSdk = 35

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
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
