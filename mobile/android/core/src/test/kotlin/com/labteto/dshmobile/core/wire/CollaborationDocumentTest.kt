package com.labteto.dshmobile.core.wire

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

class CollaborationDocumentTest {
    @Test fun switchingFromListOrAnotherTaskNeverReadsMissingTask() {
        assertNull(Json.parseToJsonElement("{\"tasks\":[]}").jsonObject.collaborationTask("second"))
        assertNull(Json.parseToJsonElement("{\"task\":{\"id\":\"first\"}}").jsonObject.collaborationTask("second"))
        assertNull(Json.parseToJsonElement("{\"task\":null}").jsonObject.collaborationTask("second"))
        val detail = Json.parseToJsonElement("{\"task\":{\"id\":\"second\"}}").jsonObject
        assertEquals(detail["task"], detail.collaborationTask("second"))
    }
}
