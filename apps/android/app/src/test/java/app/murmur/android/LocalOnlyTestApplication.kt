package app.murmur.android

import android.app.Application

/**
 * The Application the Robolectric tests run under (src/test/resources/robolectric.properties).
 *
 * [MurmurApplication] reads the Convex URL and Clerk key the build baked in and, when they are
 * set, initialises Clerk and the real Convex client. That client is Rust behind UniFFI and loads
 * its native library through JNA; the AAR carries Android ABIs only, so on the JVM the load fails
 * in `Application.onCreate` and every test dies before it starts. Cloud builds (`MURMUR_CLOUD_RELEASE`)
 * bake those values into the debug variant the unit tests use as well.
 *
 * This class is not a [MurmurApplication], so `(app as? MurmurApplication)?.cloudConfig` answers
 * `CloudConfig.OFF` everywhere: the tests exercise the app in local mode whatever the build bakes
 * in, as they did before the first cloud build. Tests of the cloud path (CloudSyncTest,
 * HistorySyncTest, InferenceTest, ParitySettingsScreensTest) build their own `CloudConfig` and a
 * fake Convex client.
 */
class LocalOnlyTestApplication : Application()
