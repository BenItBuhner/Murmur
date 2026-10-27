package app.murmur.android

import app.murmur.android.text.AppCategory
import app.murmur.android.text.Verify
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors packages/text-engine/tests/repair-case.test.ts. */
class RepairCaseTest {
    private fun fix(raw: String, text: String, category: AppCategory = AppCategory.CHAT, instructions: String? = null) =
        Verify.repairCase(raw, text, category, instructions)

    @Test
    fun `repairCase restores dropped capitals`() {
        val raw = "We can keep on working. We can keep on going and we can figure this shit out. I need you to figure it out. I'm fucking tired of it. I've fucking had it with you."
        val model = "we can keep on working. we can keep on going and we can figure this shit out. i need you to figure it out. i’m fucking tired of it. i’ve fucking had it with you."
        assertEquals(
            "we can keep on working. We can keep on going and we can figure this shit out. I need you to figure it out. I’m fucking tired of it. I’ve fucking had it with you.",
            fix(raw, model)
        )
        assertEquals(
            "the most amazing experience possible I'll give you more context, but right now, I think it's best",
            fix("possible. I'll give you more context. Right now, I think it's best", "the most amazing experience possible i'll give you more context, but right now, i think it's best")
        )
        assertEquals("think what will help. Think again.", fix("think what will help", "think what will help. think again."))
        assertEquals("Really? Because I doubt it! And \"yes.\" Then go", fix("a", "Really? because I doubt it! and \"yes.\" then go"))
    }

    @Test
    fun `repairCase leaves abbreviations, mixed case, code and lower-case styles alone`() {
        assertEquals("The CEOs are founders, etc. and it can be based on size.", fix("The CEOs, etc. And it can be", "The CEOs are founders, etc. and it can be based on size."))
        assertEquals("Use e.g. this one, i.e. the second.", fix("a", "Use e.g. this one, i.e. the second."))
        assertEquals("I was thinking... maybe not.", fix("a", "I was thinking... maybe not."))
        assertEquals("We moved to the U.S. last year.", fix("a", "We moved to the U.S. last year."))
        assertEquals("I bought it. iPhone sales are up. eBay too.", fix("a", "I bought it. iPhone sales are up. eBay too."))
        assertEquals("Version 2. npm install works.", fix("version 2. npm install works", "Version 2. npm install works."))
        assertEquals("Set the iOS flag, run ./i and open i/o. The wi-fi is down.", fix("a", "Set the iOS flag, run ./i and open i/o. The wi-fi is down."))
        assertEquals("for i in range ten", fix("for i in range", "for i in range ten"))
        assertEquals("git commit. then push", fix("a", "git commit. then push", AppCategory.CODE))
        assertEquals("git commit. then push", fix("a", "git commit. then push", AppCategory.TERMINAL))
        assertEquals("hey. i am here", fix("a", "hey. i am here", AppCategory.CHAT, "Write everything in lowercase."))
        assertEquals("ok. i will be there", Verify.repairCase("a", "ok. i will be there", AppCategory.CHAT, null, "yo are we still on for tonight"))
        assertEquals("ok. I will be there", Verify.repairCase("a", "ok. i will be there", AppCategory.CHAT, null, "Are we still on for tonight?"))
        assertEquals("ok. I will be there", Verify.repairCase("a", "ok. i will be there", AppCategory.CHAT, null, "ok"))
        val t = "I think it's fine. We'll see. I'm sure."
        assertEquals(t, fix(t, t))
    }
}
