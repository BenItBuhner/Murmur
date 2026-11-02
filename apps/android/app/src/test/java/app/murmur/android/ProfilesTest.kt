package app.murmur.android

import app.murmur.android.settings.AppRule
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.Casing
import app.murmur.android.text.Layout
import app.murmur.android.text.finish
import app.murmur.android.text.resolveStyle
import org.junit.Assert.assertEquals
import org.junit.Test

/** Profiles resolve as on the desktop (packages/text-engine/tests/profiles.test.ts). */
class ProfilesTest {
    private val slack = AppContext("com.Slack", AppCategory.CHAT, "Slack")
    private val gmail = AppContext("com.google.android.gm", AppCategory.EMAIL, "Gmail")

    @Test
    fun `Default changes nothing`() {
        val s = resolveStyle(MurmurSettings(), slack)
        assertEquals("default", s.profile.id)
        assertEquals(Tone.CASUAL, s.tone)
        assertEquals(Layout.AUTO, s.layout)
        assertEquals(Casing.STANDARD, s.casing)
    }

    @Test
    fun `a per-app profile wins over the global one`() {
        val settings = MurmurSettings(profile = "polished", appRules = listOf(AppRule("r", "slack", profile = "casual")))
        val chat = resolveStyle(settings, slack)
        assertEquals("casual", chat.profile.id)
        assertEquals(Casing.LOWERCASE, chat.casing)
        val mail = resolveStyle(settings, gmail)
        assertEquals("polished", mail.profile.id)
        assertEquals(Tone.PROFESSIONAL, mail.tone)
        assertEquals(Layout.STRUCTURED, mail.layout)
    }

    @Test
    fun `tone precedence is rule tone, rule profile, global tone, global profile, app`() {
        fun tone(global: MurmurSettings, rule: AppRule? = null) =
            resolveStyle(global.copy(appRules = listOfNotNull(rule)), slack).tone
        assertEquals(Tone.NEUTRAL, tone(MurmurSettings(profile = "polished"), AppRule("r", "slack", Tone.NEUTRAL, profile = "casual")))
        assertEquals(Tone.PROFESSIONAL, tone(MurmurSettings(tone = Tone.NEUTRAL), AppRule("r", "slack", profile = "polished")))
        assertEquals(Tone.NEUTRAL, tone(MurmurSettings(tone = Tone.NEUTRAL, profile = "polished")))
        assertEquals(Tone.PROFESSIONAL, tone(MurmurSettings(profile = "polished")))
        assertEquals(Tone.CASUAL, tone(MurmurSettings()))
    }

    @Test
    fun `an unknown profile reads as Default`() {
        assertEquals("default", resolveStyle(MurmurSettings(profile = "from-the-future"), gmail).profile.id)
    }

    @Test
    fun `finish lowers the casing before the trailing space`() {
        val out = finish("Sounds good.", AppCategory.CHAT, emptyList(), trailingSpace = true, casing = Casing.LOWERCASE)
        assertEquals("sounds good ", out.text)
        assertEquals(true, out.stages.contains("casing"))
    }
}
