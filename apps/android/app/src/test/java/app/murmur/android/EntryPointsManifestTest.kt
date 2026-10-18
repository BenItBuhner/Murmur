package app.murmur.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import app.murmur.android.entry.EntryActions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

/**
 * The wiring external triggers depend on, exactly as the merged manifest and resource table ship
 * it: the trampoline answers all four actions (exported), the Quick Settings tile is guarded by
 * BIND_QUICK_SETTINGS_TILE, and every static shortcut lands in our own trampoline.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EntryPointsManifestTest {

    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val pm: PackageManager get() = context.packageManager

    @Test
    fun `every entry action resolves to the exported trampoline`() {
        for (action in EntryActions.ALL) {
            val resolved = pm.resolveActivity(
                Intent(action).addCategory(Intent.CATEGORY_DEFAULT),
                PackageManager.MATCH_DEFAULT_ONLY
            )
            assertNotNull("nothing answers $action", resolved)
            assertEquals("$action should reach the trampoline",
                "app.murmur.android.entry.DictationEntryActivity", resolved!!.activityInfo.name)
            assertEquals("$action must be reachable from other apps", true, resolved.activityInfo.exported)
        }
    }

    @Test
    fun `the tile is bound only by the system`() {
        val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SERVICES)
        val tile = info.services!!.single { it.name == "app.murmur.android.entry.DictationTileService" }
        assertEquals("the system alone may bind it",
            "android.permission.BIND_QUICK_SETTINGS_TILE", tile.permission)
        assertEquals(true, tile.exported)
        assertEquals("Dictate", tile.loadLabel(pm))
    }

    @Test
    fun `MainActivity carries the shortcuts`() {
        val main = pm.getActivityInfo(ComponentName(context, "app.murmur.android.MainActivity"), PackageManager.GET_META_DATA)
        val resource = main.metaData?.getInt("android.app.shortcuts") ?: 0
        assertTrue("android.app.shortcuts points at our resource", resource != 0)
        assertEquals(R.xml.shortcuts, resource)
    }

    @Test
    fun `every shortcut lands in our own trampoline`() {
        val shortcuts = parseShortcuts()
        assertEquals(listOf("dictate", "stop_dictation", "dictate_command"), shortcuts.map { it.id })
        for (s in shortcuts) {
            assertEquals(BuildConfig.APPLICATION_ID, s.targetPackage)
            assertEquals("a shortcut's class must resolve",
                "app.murmur.android.entry.DictationEntryActivity",
                Class.forName(s.targetClass).name)
            assertTrue("a shortcut fires one of our actions: ${s.action}", s.action in EntryActions.ALL)
        }
    }

    @Test
    fun `the command shortcut asks for command mode`() {
        val command = parseShortcuts().single { it.id == "dictate_command" }
        assertEquals(EntryActions.START_DICTATION, command.action)
        assertEquals("command", command.extraMode)
    }

    /** The static shortcuts as the resource table carries them (res/xml/shortcuts.xml). */
    private data class Shortcut(val id: String, val action: String, val targetPackage: String, val targetClass: String, val extraMode: String?)

    private fun parseShortcuts(): List<Shortcut> {
        val parser = context.resources.getXml(R.xml.shortcuts)
        val androidNs = "http://schemas.android.com/apk/res/android"
        val out = ArrayList<Shortcut>()
        var id: String? = null
        var action: String? = null
        var targetPackage: String? = null
        var targetClass: String? = null
        var mode: String? = null
        var depth = 0
        var eventType = parser.eventType
        while (eventType != XmlPullParser.END_DOCUMENT) {
            when (eventType) {
                XmlPullParser.START_TAG -> {
                    depth++
                    when (parser.name) {
                        "shortcut" -> id = parser.getAttributeValue(androidNs, "shortcutId")
                        "intent" -> {
                            action = parser.getAttributeValue(androidNs, "action")
                            targetPackage = parser.getAttributeValue(androidNs, "targetPackage")
                            targetClass = parser.getAttributeValue(androidNs, "targetClass")
                        }
                        "extra" -> mode = parser.getAttributeValue(androidNs, "value")
                    }
                }
                XmlPullParser.END_TAG -> {
                    if (depth == 2 && parser.name == "shortcut" && id != null) {
                        out.add(Shortcut(id!!, action!!, targetPackage!!, targetClass!!, mode))
                        mode = null
                    }
                    depth--
                }
            }
            eventType = parser.next()
        }
        parser.close()
        return out
    }
}
