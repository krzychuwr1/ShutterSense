package dev.shuttersense.app

import dev.shuttersense.app.agent.cleanMenu
import dev.shuttersense.app.agent.screenHint
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MenuScreensTest {
    @Test
    fun cleansScreensLikeTheWebVersion() {
        val raw = Json.parseToJsonElement(
            """[
              {"tab":"af","page":1,"items":["AF operation","  Subject   to detect ","Eye detection"],"select":"Subject to detect"},
              {"tab":"af","items":["People","Animals"],"select":"Vehicles"},
              {"tab":"bogus","items":["x"],"select":"x"},
              {"tab":"shoot","page":"30","items":[],"select":""},
              {"tab":"setup","page":"2","items":[1, "Language"],"select":"Language"}
            ]""",
        )
        val out = cleanMenu(raw)
        assertEquals(3, out.size)
        assertEquals(listOf("AF operation", "Subject to detect", "Eye detection"), out[0].items)
        assertEquals(1, out[0].page)
        // The selection joins the rows when missing.
        assertEquals(listOf("People", "Animals", "Vehicles"), out[1].items)
        assertNull(out[1].page)
        assertEquals(2, out[2].page)
        assertEquals(listOf("Language"), out[2].items)
        assertEquals("Press MENU, open the AF tab, page 1, select Subject to detect", screenHint(out[0], 0))
        assertEquals("Select Vehicles", screenHint(out[1], 1))
        assertTrue(cleanMenu(null).isEmpty())
    }

    @Test
    fun keepsTheCameraScreenFieldsLikeTheWebVersion() {
        // The shape the worker builds from the menu map (shared/menu.ts menuPath).
        val raw = Json.parseToJsonElement(
            """[
              {"tab":"shoot","page":2,"pages":10,"items":["Expo.comp./AEB","ISO speed settings","Highlight tone priority"],
               "values":["-3..+3","","OFF"],"dim":["Expo.comp./AEB","Nope"],"select":"Highlight tone priority","model":"EOS R6 Mark II"},
              {"tab":"shoot","title":"Highlight tone priority","items":["Disable","Enable","Enhanced"],"values":["OFF","D+","D+2"],
               "current":"Disable","select":"Enable"},
              {"tab":"shoot","title":"IS mode","items":["Off","On"],"current":"Elsewhere","select":"On","popup":true,"pages":3}
            ]""",
        )
        val out = cleanMenu(raw)
        assertEquals(3, out.size)
        assertEquals(10, out[0].pages)
        assertEquals(listOf("-3..+3", "", "OFF"), out[0].values)
        assertEquals(listOf("Expo.comp./AEB"), out[0].dim)
        assertEquals("EOS R6 Mark II", out[0].model)
        assertFalse(out[0].isSub)
        assertTrue(out[1].isSub)
        assertEquals("Disable", out[1].current)
        assertEquals("D+", out[1].value(1))
        assertTrue(out[2].popup)
        assertNull(out[2].current)
        // A sub-screen has no page row.
        assertNull(out[2].pages)
        // Relayed to the glasses and back unchanged.
        val again = cleanMenu(kotlinx.serialization.json.JsonArray(out.map { it.toJson() }))
        assertEquals(out, again)
    }
}
