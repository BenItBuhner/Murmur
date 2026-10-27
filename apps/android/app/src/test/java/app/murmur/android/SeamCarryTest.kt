package app.murmur.android

import app.murmur.android.text.AppCategory
import app.murmur.android.text.CarriedPart
import app.murmur.android.text.CarrySplit
import app.murmur.android.text.Verify
import app.murmur.android.text.carryInput
import app.murmur.android.text.joinCarried
import app.murmur.android.text.joinSeam
import app.murmur.android.text.splitCarry
import org.junit.Assert.assertEquals
import org.junit.Test

/** Mirrors packages/text-engine/tests/seam-carry.test.ts and repair-case.test.ts. */
class SeamCarryTest {
    private fun soft(a: String, b: String) = joinSeam(a, b, soft = true).text

    @Test
    fun `soft join drops the clip-end period and continues in lower case`() {
        assertEquals("I want you to dig deeper and actually merge things yourself.", soft("I want you to dig deeper.", "And actually merge things yourself."))
        assertEquals("or make any decisions any major mistakes.", soft("or make any decisions.", "Any major mistakes."))
        assertEquals("It is a question of if we can.", soft("It is a question of...", "If we can."))
        assertEquals("Every single clip is cut.", soft("Every single…", "Clip is cut."))
    }

    @Test
    fun `soft join keeps question marks, I and names, and still dedupes`() {
        assertEquals("Is it done? Yes it is.", soft("Is it done?", "Yes it is."))
        assertEquals("Wow! That was fast.", soft("Wow!", "That was fast."))
        assertEquals("That is the plan I'll send it later.", soft("That is the plan.", "I'll send it later."))
        assertEquals("I sent it to Sarah, and Sarah said no.", soft("I sent it to.", "Sarah, and Sarah said no."))
        assertEquals("We moved it to the API gateway.", soft("We moved it to the.", "API gateway."))
        assertEquals("Everything that would otherwise be picked up.", soft("Everything that would otherwise.", "Otherwise, be picked up."))
        assertEquals("It adds an extra step.", soft("It adds a", "An extra step."))
        assertEquals("the build is green now.", soft("the build is", "Green now."))
        assertEquals("Hello there.", soft("", "Hello there."))
        assertEquals("Hello there.", soft("Hello there.", ""))
        assertEquals("Version 2.0 shipped. We tested it then it broke.", soft("Version 2.0 shipped. We tested it.", "Then it broke."))
    }

    @Test
    fun `splitCarry carries the last sentence, never a list item or a long one`() {
        assertEquals(CarrySplit("There are issues.", "I want you to dig deeper."), splitCarry("There are issues. I want you to dig deeper."))
        assertEquals(CarrySplit("We shipped it.", "Then the build"), splitCarry("We shipped it. Then the build"))
        assertEquals(CarrySplit("", "Just one sentence here."), splitCarry("Just one sentence here."))
        val long = "Start. " + "word ".repeat(45).trim() + "."
        assertEquals(CarrySplit(long, ""), splitCarry(long))
        val list = "Three things:\n1. Finish the deck\n2. Email the vendor"
        assertEquals(CarrySplit(list, ""), splitCarry(list))
        assertEquals(CarrySplit("Dear Sam,\n\n", "Thanks for the notes"), splitCarry("Dear Sam,\n\nThanks for the notes"))
        assertEquals(CarrySplit("", ""), splitCarry("   "))
        assertEquals(CarrySplit("She said \"go.\"", "Then we went"), splitCarry("She said \"go.\" Then we went"))
    }

    @Test
    fun `carryInput soft-joins only what the model will see`() {
        assertEquals(
            "I want you to dig deeper and actually merge things yourself. I only want you to hold them when I say.",
            carryInput("I want you to dig deeper.", "And actually merge things yourself. I only want you to hold them when I say.")
        )
        assertEquals(
            "so we should test the whole thing again tomorrow morning before the release goes out.",
            carryInput("so we should test the whole.", "The whole thing again tomorrow morning before the release goes out.")
        )
        assertEquals("That is the whole plan for this week and the next. Send it now.", carryInput("That is the whole plan for this week and the next.", "Send it now."))
        assertEquals("Okay. Send it to Sarah tomorrow morning please.", carryInput("Okay.", "Send it to Sarah tomorrow morning please."))
        assertEquals(
            "I want you to dig deeper. And actually merge things yourself. I only want you to hold them when I say.",
            carryInput("I want you to dig deeper.", "And actually merge things yourself. I only want you to hold them when I say.", soft = false)
        )
    }

    @Test
    fun `joinCarried replaces the carried sentence and chains`() {
        assertEquals(
            "There are issues. I want you to dig deeper and actually merge things yourself. Hold only what I say.",
            joinCarried(listOf(
                CarriedPart("There are issues. I want you to dig deeper."),
                CarriedPart("I want you to dig deeper and actually merge things yourself. Hold only what I say.", carried = true)
            )).text
        )
        assertEquals(
            "One. Two three four five. Six.",
            joinCarried(listOf(CarriedPart("One. Two three"), CarriedPart("Two three four", true), CarriedPart("Two three four five. Six.", true))).text
        )
        assertEquals("Everything that would otherwise be picked up.", joinCarried(listOf(CarriedPart("Everything that would otherwise."), CarriedPart("Otherwise, be picked up."))).text)
        assertEquals("Dear Sam,\n\nThanks for the notes.", joinCarried(listOf(CarriedPart("Dear Sam,\n\nThanks for the"), CarriedPart("Thanks for the notes.", true))).text)
        assertEquals("A b. C d.", joinCarried(listOf(CarriedPart("A b."), CarriedPart(""), CarriedPart("C d."))).text)
        assertEquals("Hi there.", joinCarried(listOf(CarriedPart("Hi there.", true))).text)
    }

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
        val t = "I think it's fine. We'll see. I'm sure."
        assertEquals(t, fix(t, t))
    }
}
