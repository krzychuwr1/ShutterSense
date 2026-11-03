package dev.shuttersense.app

import dev.shuttersense.app.agent.MenuSetting
import dev.shuttersense.app.agent.cleanPreset
import dev.shuttersense.app.agent.presetKey
import dev.shuttersense.app.agent.presetLine
import dev.shuttersense.app.agent.presetLines
import dev.shuttersense.app.agent.presetSummary
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresetsTest {
    private fun clean(json: String) = cleanPreset(Json.parseToJsonElement(json))

    @Test
    fun namesMatchIgnoringCaseAndSpacing() {
        assertEquals("club night", presetKey("  Club \t NIGHT "))
    }

    @Test
    fun anythingWithoutANameIsNoPreset() {
        assertNull(clean("""{"note":"x"}"""))
        assertNull(clean("""{"name":"   "}"""))
        assertNull(clean("""["Club night"]"""))
        assertNull(clean("\"Club night\""))
    }

    @Test
    fun keepsOnlyAgentSettingsInTheirOrder() {
        val p = clean(
            """{"name":"  Club   night ","note":"Dim LED\nstage","saved":"2026-11-03T10:00:00.000Z",
               "settings":{"iso":"auto","tv":"1/250","storage":"card2","colortemperature":5600.0,"av":"","flash":true,
                 "wbshift":{"ba":"2","mg":-1.6},"style_detail":{"contrast":2.4,"saturation":"x","colortone":-1}},
               "menu":[{"setting":"HDR Mode","value":"Auto"},{"setting":"","value":"x"},"junk",
                 {"setting":"a","value":"1"},{"setting":"b","value":"2"},{"setting":"c","value":"3"},{"setting":"d","value":"4"}]}""",
        )!!
        assertEquals("Club night", p.name)
        assertEquals("Dim LED stage", p.note)
        assertEquals("2026-11-03T10:00:00.000Z", p.saved)
        assertEquals(listOf("tv", "iso", "colortemperature", "wbshift", "style_detail"), p.settings.keys.toList())
        assertEquals(listOf(MenuSetting("HDR Mode", "Auto"), MenuSetting("a", "1"), MenuSetting("b", "2"), MenuSetting("c", "3")), p.menu)
        assertEquals(
            """tv 1/250, iso auto, colortemperature 5600, wbshift {"ba":2,"mg":-2}, style_detail {"contrast":2,"colortone":-1}; by hand: HDR Mode Auto, a 1, b 2, c 3""",
            presetLine(p),
        )
        assertEquals(
            listOf(
                "Shutter: 1/250 s",
                "ISO: auto",
                "Colour temp.: 5600 K",
                "WB shift: ba 2, mg -2",
                "Style detail: Contrast 2, Colour tone -1",
                "HDR Mode (by hand): Auto",
                "a (by hand): 1",
                "b (by hand): 2",
                "c (by hand): 3",
            ),
            presetLines(p),
        )
    }

    @Test
    fun aPresetWithoutADateGetsTheEpochAndTheSummaryIsCut() {
        val p = clean("""{"name":"x","settings":{"tv":"${"1".repeat(60)}"}}""")!!
        assertEquals("1970-01-01T00:00:00.000Z", p.saved)
        assertEquals("tv ${"1".repeat(40)}", presetLine(p))
        assertEquals(presetLine(p), presetSummary(p).settings)
    }
}
