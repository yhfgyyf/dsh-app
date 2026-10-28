package com.labteto.dshmobile.core.wire

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A list or another task's response must never be rendered as this task's detail. */
fun JsonObject.collaborationTask(expectedId: String): JsonObject? =
    (get("task") as? JsonObject)?.takeIf { (it["id"] as? JsonPrimitive)?.content == expectedId }
