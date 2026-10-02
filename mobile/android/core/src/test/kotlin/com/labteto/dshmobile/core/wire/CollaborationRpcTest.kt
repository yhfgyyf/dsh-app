package com.labteto.dshmobile.core.wire

import java.io.InputStream
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CollaborationRpcTest {
    @Test fun `collaboration requests preserve the custom channel envelope and server errors`() = runTest {
        val requests = mutableListOf<Pair<String, JsonObject>>()
        var fail = false
        val client = DshApiClient(object : RpcTransport {
            override suspend fun post(path: String, body: String): RpcHttpResponse {
                requests += path to Json.parseToJsonElement(body).jsonObject
                return RpcHttpResponse(200, if (fail) """{"type":"server-response","rpcId":"test","result":{"ok":false,"error":{"code":"collab/failed","message":"draft preserved","details":{}}}}""" else """{"type":"server-response","rpcId":"test","result":{"ok":true,"value":{"id":"task-a"}}}""")
            }
            override suspend fun <T> download(path: String, consume: (String?, String?, InputStream) -> T): T = error("not used")
            override suspend fun upload(path: String, contentType: String, contentLength: Long, body: InputStream, onProgress: ((Long) -> Unit)?): RpcHttpResponse = error("not used")
        })
        val args = buildJsonObject { put("body", "# Markdown"); put("taskId", "task-a") }
        assertTrue(client.collaboration("reply", args) is RpcResult.Ok)
        assertEquals("/desktop-collab/reply", requests.single().first)
        assertEquals(JsonPrimitive("reply"), requests.single().second["method"])
        assertEquals(args, requests.single().second.getValue("payload").jsonObject["args"])
        fail = true
        assertEquals("draft preserved", (client.collaboration("reply", args) as RpcResult.Err).error.message)
    }
}
