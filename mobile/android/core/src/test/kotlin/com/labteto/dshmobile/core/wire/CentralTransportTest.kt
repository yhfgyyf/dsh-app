package com.labteto.dshmobile.core.wire

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test

class CentralTransportTest {
    @Test fun kotlinDecodesThePinnedDesktopHost() = runBlocking {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "services/relay/test/kotlin-fixture.ts").exists() }
        val process = ProcessBuilder("node", "services/relay/node_modules/tsx/dist/cli.mjs", "services/relay/test/kotlin-fixture.ts", "--real-host").directory(root).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val http = OkHttpClient()
        try {
            val fixture = Json.parseToJsonElement(process.inputStream.bufferedReader().readLine()).jsonObject
            val credential = CentralCredential(fixture.text("bindingId"), fixture.text("bindingToken"), fixture.text("key"))
            val api = DshApiClient(CentralRpcTransport(fixture.text("origin"), http, credential))
            val created = api.sessionCreate(com.labteto.dshmobile.core.wire.dto.SessionCreateRequest(cwd = fixture.text("cwd"), agentPreset = "standard"))
            assertTrue(created is RpcResult.Ok)
            val id = (created as RpcResult.Ok).value.sessionId
            val renamed = api.sessionRename(com.labteto.dshmobile.core.wire.dto.SessionRenameRequest(id, "Kotlin actual Host"))
            assertTrue(renamed is RpcResult.Ok)
            val listed = api.sessionList()
            assertTrue(listed is RpcResult.Ok)
            assertTrue((listed as RpcResult.Ok).value.items.any { it.sessionId == id && it.projections?.values.toString().contains("Kotlin actual Host") })
        } finally { http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown(); process.outputStream.close(); if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly() }
    }

    @Test fun kotlinTalksToNodeRelayAndDesktopBridge() = runBlocking {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "services/relay/test/kotlin-fixture.ts").exists() }
        val process = ProcessBuilder("node", "services/relay/node_modules/tsx/dist/cli.mjs", "services/relay/test/kotlin-fixture.ts").directory(root).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        try {
            val fixture = Json.parseToJsonElement(process.inputStream.bufferedReader().readLine()).jsonObject
            val credential = CentralCredential(fixture.text("bindingId"), fixture.text("bindingToken"), fixture.text("key"))
            val http = OkHttpClient()
            val rpc = CentralRpcTransport(fixture.text("origin"), http, credential)
            val body = "{\"args\":{\"text\":\"中文 Kotlin\"}}"
            assertEquals(body, rpc.post("/api/session/list", body).body)
            val upload = ByteArray(1024 * 1024 + 3) { 97 }
            assertEquals(upload.size, rpc.upload("/api/session/uploadFileBinary", "application/octet-stream", upload.size.toLong(), upload.inputStream()).body.length)
            val downloaded = rpc.download("/api/session/export") { _, _, stream -> var count = 0; val bytes = ByteArray(8192); while(true) { val n = stream.read(bytes); if(n<0)break; for(i in 0 until n) assertEquals(97,bytes[i].toInt()); count+=n }; count }
            assertEquals(1024 * 1024 + 7, downloaded)
            val opened = CountDownLatch(1); val ready = CountDownLatch(1)
            val mux = CentralWsChannel(fixture.text("origin"), http, credential, object : WsChannelSink {
                override fun onOpen() { opened.countDown() }
                override fun onMessage(text: String) { if (text.contains("test-kotlin-client")) ready.countDown() }
                override fun onClosed(cause: Throwable?) {}
            })
            try {
                mux.start(); assertTrue(opened.await(15,TimeUnit.SECONDS))
                assertTrue(mux.send("{\"type\":\"open\",\"streamId\":\"events\",\"endpoint\":\"\$events\",\"payload\":{\"args\":{}}}"))
                assertTrue(ready.await(15,TimeUnit.SECONDS))
            } finally { mux.close(); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
        } finally { process.outputStream.close(); if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly() }
    }
}
