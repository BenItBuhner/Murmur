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

android {
    namespace = "app.murmur.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.murmur.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "DEFAULT_BASE_URL", "\"${envOrProp("MURMUR_BASE_URL")}\"")
        buildConfigField("String", "DEFAULT_API_KEY", "\"${envOrProp("MURMUR_API_KEY")}\"")
        buildConfigField("String", "DEFAULT_STT_MODEL", "\"${envOrProp("MURMUR_STT_MODEL")}\"")
        buildConfigField("String", "DEFAULT_LLM_MODEL", "\"${envOrProp("MURMUR_LLM_MODEL")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
