package dev.shuttersense.app

import dev.shuttersense.app.agent.withRecentImages
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTest {
    private fun imageOutput(id: String) = buildJsonObject {
        put("type", "function_call_output")
        put("call_id", id)
        put("output", buildJsonArray {
            add(buildJsonObject { put("type", "input_text"); put("text", "frame $id") })
            add(buildJsonObject { put("type", "input_image"); put("image_url", "data:image/jpeg;base64,AAAA") })
        })
    }

    private fun images(items: List<JsonObject>) = items.count { item ->
        (item["output"] as? JsonArray)?.any { (it as JsonObject)["type"] == JsonPrimitive("input_image") } == true
    }

    @Test
    fun keepsOnlyTheLastThreeImages() {
        val input = listOf(
            buildJsonObject { put("role", "user"); put("content", "Goal: x") },
        ) + (1..5).map { imageOutput("c$it") }
        val out = withRecentImages(input)
        assertEquals(3, images(out))
        assertEquals(5, images(input)) // the original is untouched
        val first = (out[1]["output"] as JsonArray)[1] as JsonObject
        assertEquals(JsonPrimitive("[older image removed]"), first["text"])
        assertEquals(input.size, out.size)
    }
}
