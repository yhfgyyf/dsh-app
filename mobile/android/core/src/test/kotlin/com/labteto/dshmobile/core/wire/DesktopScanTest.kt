package com.labteto.dshmobile.core.wire

import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Test
import com.labteto.dshmobile.core.wire.dto.*

class DesktopScanTest {
    private fun <T> RpcResult<T>.checked(): T = when (this) {
        is RpcResult.Ok -> value
        is RpcResult.Err -> error("${error.code}: ${error.message} ${error.details}")
    }

    private fun officeFixture(file: File, parts: Map<String, String>) {
        java.util.zip.ZipOutputStream(file.outputStream()).use { zip -> parts.forEach { (name, text) ->
            zip.putNextEntry(java.util.zip.ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry()
        } }
    }

    @Test fun recordedSpeechIsTranscribedOnTheComputer() {
        val wave = System.getenv("DSH_TEST_SPEECH_WAV")
        org.junit.Assume.assumeTrue("Optional local ASR smoke needs verified models and a WAV fixture", wave != null && System.getenv("DSH_TEST_SPEECH_MODELS") != null)
        fixture(false) { f, http ->
            val credential = pairDesktop(http, checkNotNull(CentralPairCode.parse(f.getValue("qr").toString())), "Android speech")
            val api = DshApiClient(CentralRpcTransport("", http, credential))
            var catalog = api.speechCatalog().checked()
            withTimeout(10_000) {
                while (catalog.providers.any { it.preparation.phase == "checking" }) { delay(100); catalog = api.speechCatalog().checked() }
            }
            assertEquals(1, catalog.providers.count { it.id == catalog.selection.providerId })
            val provider = catalog.providers.single { it.id == catalog.selection.providerId }
            assertEquals("host-local", provider.location)
            assertEquals("standby", provider.preparation.phase)
            api.speechPrepare(provider.id).checked()
            withTimeout(30_000) {
                while (api.speechCatalog().checked().providers.single { it.id == provider.id }.preparation.phase != "ready") delay(100)
            }
            val text = api.speechTranscribe(SpeechTranscriptionRequest(java.util.Base64.getEncoder().encodeToString(File(wave!!).readBytes()), provider.id, "auto")).checked().text
            assertTrue("Expected Chinese transcription, received: $text", text.contains("文件"))
        }
    }

    @Test fun phonePreviewsAndTerminalUseTheActualConnectedComputer() = fixture(false) { f, http ->
        val qr = checkNotNull(CentralPairCode.parse(f.getValue("qr").toString()))
        val credential = pairDesktop(http, qr, "Android preview and terminal")
        val api = DshApiClient(CentralRpcTransport("", http, credential))
        val id = api.sessionCreate(SessionCreateRequest(cwd = f.text("cwd"), agentPreset = "standard")).checked().sessionId
        val cwd = File(f.text("cwd"))
        val image = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=")
        File(cwd, "preview.png").writeBytes(image)
        assertArrayEquals(image, api.workspaceFileReadBytes(id, "preview.png").checked().data)
        val movie = ByteArray(17 * 1024 * 1024 + 123) { (it % 251).toByte() }
        File(cwd, "preview.mp4").writeBytes(movie)
        val output = java.io.ByteArrayOutputStream()
        com.labteto.dshmobile.core.session.copyWorkspacePreview(api.workspaceFileStat(id, "preview.mp4").checked(), 32L * 1024 * 1024, output,
            { range -> api.workspaceFileReadBytes(id, "preview.mp4", WorkspaceByteReadOptions(range = range)) })
        assertArrayEquals(movie, output.toByteArray())
        officeFixture(File(cwd, "preview.docx"), mapOf(
            "[Content_Types].xml" to """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""",
            "_rels/.rels" to """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
            "word/document.xml" to """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Phone preview on Host</w:t></w:r></w:p></w:body></w:document>""",
        ))
        officeFixture(File(cwd, "preview.xlsx"), mapOf(
            "[Content_Types].xml" to """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>""",
            "_rels/.rels" to """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>""",
            "xl/workbook.xml" to """<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Preview" sheetId="1" r:id="rId1"/></sheets></workbook>""",
            "xl/_rels/workbook.xml.rels" to """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>""",
            "xl/worksheets/sheet1.xml" to """<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Phone table preview</t></is></c></row></sheetData></worksheet>""",
        ))
        for (name in listOf("preview.docx", "preview.xlsx")) {
            val source = api.workspaceFileStat(id, name).checked()
            val pdf = api.officePreview(id, name).checked()
            assertEquals(source.version, pdf.version)
            assertTrue(pdf.eof)
            assertEquals("%PDF-", pdf.data.copyOfRange(0, 5).decodeToString())
            val original = java.io.ByteArrayOutputStream()
            com.labteto.dshmobile.core.session.copyWorkspacePreview(source, 256L * 1024 * 1024, original,
                { range -> api.workspaceFileReadBytes(id, name, WorkspaceByteReadOptions(range = range)) })
            assertArrayEquals(File(cwd, name).readBytes(), original.toByteArray())
        }
        val catalog = api.speechCatalog().checked()
        assertTrue(catalog.maxAudioBytes >= 32044)
        assertTrue(catalog.providers.any { it.location == "host-local" })
        val environment = api.terminalEnvironment(id).checked()
        assertEquals(cwd.canonicalPath, File(environment.cwd).canonicalPath)
        assertTrue(api.terminalShells(id).checked().isNotEmpty())
        val terminal = api.terminalCreate(id, TerminalCreateRequest(java.util.UUID.randomUUID().toString(), 80, 24)).checked()
        val mux = RemoteStreamMux { sink -> CentralWsChannel("", http, credential, sink) }
        try {
            mux.start(); withTimeout(10_000) { mux.awaitOpen() }
            val attachment = java.util.UUID.randomUUID().toString()
            val stream = mux.open("terminal/follow", remoteObject("agentId" to id, "id" to terminal.id, "attachmentId" to attachment))
            assertEquals("snapshot", withTimeout(10_000) { stream.receive() }!!.jsonObject.text("type"))
            val retain = mux.open("terminal/retain", remoteObject("sessionId" to id, "id" to terminal.id))
            assertNotNull(withTimeout(5000) { retain.receive() })
            api.terminalResize(id, terminal.id, attachment, 92, 30).checked()
            // A harmless command whose response proves this is the computer's actual shell.
            api.terminalWrite(id, terminal.id, attachment, "pwd\r").checked()
            withTimeout(10_000) {
                var seen = ""
                while (!seen.contains(cwd.canonicalPath)) seen += stream.receive()?.jsonObject?.get("data")?.jsonPrimitive?.content.orEmpty()
            }
            api.terminalRename(id, terminal.id, "Phone terminal").checked()
            assertTrue(api.terminalList(id).checked().any { it.id == terminal.id && it.title == "Phone terminal" })
        } finally { api.terminalClose(id, terminal.id).checked(); mux.close() }
    }
    private fun fixture(relay: Boolean, block: suspend (JsonObject, OkHttpClient) -> Unit) = runBlocking {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "services/relay/test/scan-fixture.ts").exists() }
        val args = mutableListOf("node", "services/relay/node_modules/tsx/dist/cli.mjs", "services/relay/test/scan-fixture.ts")
        if (relay) args.add("--relay")
        val process = ProcessBuilder(args).directory(root).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val http = OkHttpClient()
        try {
            val first = process.inputStream.bufferedReader().readLine() ?: error("Scan fixture failed to start")
            block(Json.parseToJsonElement(first).jsonObject, http)
        } finally {
            http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown(); process.outputStream.close()
            if (!process.waitFor(15, TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }

    @Test fun localQrPairsWithoutRelayAndUnbindsActualHost() = fixture(false) { f, http ->
        val qr = checkNotNull(CentralPairCode.parse(f.getValue("qr").toString()))
        assertEquals("", qr.relay)
        val credential = pairDesktop(http, qr, "JVM Android")
        assertNull(credential.relay); assertEquals("", credential.bindingToken)
        assertEquals(credential, CentralCredential.decode(credential.encode()))
        val transport = CentralRpcTransport("", http, credential)
        val api = DshApiClient(transport)
        val created = api.sessionCreate(com.labteto.dshmobile.core.wire.dto.SessionCreateRequest(cwd = f.text("cwd"), agentPreset = "standard"))
        assertTrue(created is RpcResult.Ok)
        val id = (created as RpcResult.Ok).value.sessionId
        assertTrue(api.sessionRename(com.labteto.dshmobile.core.wire.dto.SessionRenameRequest(id, "LAN QR Android")) is RpcResult.Ok)
        val listed = api.sessionList() as RpcResult.Ok
        assertTrue(listed.value.items.any { it.sessionId == id && it.projections?.values.toString().contains("LAN QR Android") })
        assertTrue(unbindDesktop(http, "", credential))
        assertTrue(runCatching { transport.post("/api/session/list", "{\"args\":{}}") }.isFailure)
        assertTrue(runCatching { pairDesktop(http, qr, "Replay") }.isFailure)
    }

    @Test fun pairedLanKeepsTheAppConnectionLoopReady() = fixture(false) { f, http ->
        val qr = checkNotNull(CentralPairCode.parse(f.getValue("qr").toString()))
        val credential = pairDesktop(http, qr, "Android connection loop")
        val connected = CompletableDeferred<HostGeneration>()
        val states = CopyOnWriteArrayList<ConnectionState>()
        val failures = CopyOnWriteArrayList<GenerationFailure>()
        val loop = ConnectionLoop(
            { RemoteStreamMux { sink -> CentralWsChannel("", http, credential, sink) } },
            object : LoopSinks {
                override fun onEventFrame(frame: com.labteto.dshmobile.core.wire.dto.RemoteEventFrame) {}
                override fun onConnected(generation: HostGeneration) { connected.complete(generation) }
                override fun onStateChange(state: ConnectionState) { states.add(state) }
                override fun onGenerationFailed(attempt: Int, failure: GenerationFailure) {
                    failures.add(failure)
                    connected.completeExceptionally(AssertionError("App connection handshake failed: $failure"))
                }
            },
            LoopConfig(streamOpenTimeoutMs = 15_000),
        )
        try {
            loop.start()
            val generation = withTimeout(20_000) { connected.await() }
            assertTrue(generation.clientId.isNotBlank())
            val api = DshApiClient(CentralRpcTransport("", http, credential))
            val created = api.sessionCreate(com.labteto.dshmobile.core.wire.dto.SessionCreateRequest(cwd = f.text("cwd"), agentPreset = "standard")) as RpcResult.Ok
            val jobs = generation.mux.open("job/list", remoteObject("request" to remoteObject("sessionId" to created.value.sessionId)))
            assertNotNull(withTimeout(5000) { jobs.receive() })
            val denied = generation.mux.open("settings/private")
            val rejection = runCatching { withTimeout(5000) { denied.receive() } }.exceptionOrNull()
            assertTrue(rejection is RemoteStreamException)
            assertFalse((rejection as RemoteStreamException).carrier)
            assertEquals("forbidden", rejection.error.code)
            // Cross both the phone's 25s ping and the desktop's 30s heartbeat twice.
            delay(65_000)
            assertEquals(emptyList<GenerationFailure>(), failures.toList())
            assertEquals(listOf(ConnectionState.RECONNECTING, ConnectionState.CONNECTED), states.toList())
            assertTrue(DshApiClient(CentralRpcTransport("", http, credential)).sessionList() is RpcResult.Ok)
        } finally { loop.stop() }
    }

    @Test fun deniedDesktopRpcReturnsAnErrorWithoutCrashingTheCaller() = fixture(false) { f, http ->
        val qr = checkNotNull(CentralPairCode.parse(f.getValue("qr").toString()))
        val credential = pairDesktop(http, qr, "Android denied request")
        val api = DshApiClient(CentralRpcTransport("", http, credential))
        val denied = api.settingsDescribe()
        assertTrue(denied is RpcResult.Err)
        assertEquals("forbidden", (denied as RpcResult.Err).error.code)
        assertTrue(api.sessionList() is RpcResult.Ok)
        assertTrue(unbindDesktop(http, "", credential))
        assertTrue(api.sessionList() is RpcResult.Err)
    }

    @Test fun lanBindingFallsBackToRelayAndPhoneRevocationReachesLan() = fixture(true) { f, http ->
        val qr = checkNotNull(CentralPairCode.parse(f.getValue("qr").toString()))
        val credential = pairDesktop(http, qr, "JVM Android fallback")
        assertEquals(f.text("origin"), credential.relay)
        assertTrue(credential.bindingToken.isNotBlank())
        // Same subnet but a closed port: exercises a failed LAN attempt before relay fallback.
        val deadPort = java.net.ServerSocket(0).use { it.localPort }
        val deadLan = credential.lanOrigins.map { it.substringBeforeLast(':') + ":" + deadPort }
        val fallback = credential.copy(lanOrigins = deadLan)
        val api = DshApiClient(CentralRpcTransport("", http, fallback))
        assertTrue(api.sessionList() is RpcResult.Ok)
        val opened = CountDownLatch(1); val ready = CountDownLatch(1); val closedEarly = AtomicBoolean(false)
        val mux = CentralWsChannel("", http, fallback, object : WsChannelSink {
            override fun onOpen() { opened.countDown() }
            override fun onMessage(text: String) { if (text.contains("\"ready\"")) ready.countDown() }
            override fun onClosed(cause: Throwable?) { if (opened.count > 0) closedEarly.set(true) }
        })
        try {
            mux.start(); assertTrue(opened.await(15, TimeUnit.SECONDS)); assertFalse(closedEarly.get())
            assertTrue(mux.send("{\"type\":\"open\",\"streamId\":\"events\",\"endpoint\":\"\$events\",\"payload\":{\"args\":{}}}"))
            assertTrue(ready.await(15, TimeUnit.SECONDS))
        } finally { mux.close() }
        assertTrue(unbindDesktop(http, "", fallback))
        // The desktop polls relay tombstones; an offline phone must not retain its LAN permission.
        val localOnly = CentralRpcTransport("", http, credential.copy(relay = null, bindingToken = ""))
        var revoked = false
        repeat(40) {
            if (!revoked) {
                revoked = runCatching { localOnly.post("/api/session/list", "{\"args\":{}}") }.isFailure
                if (!revoked) kotlinx.coroutines.delay(100)
            }
        }
        assertTrue("Relay unbind must revoke the same LAN binding", revoked)
    }

    @Test fun remoteQrClaimsWithoutPhoneLogin() = fixture(true) { f, http ->
        val code = f.getValue("qr").jsonObject
        val remoteOnly = JsonObject(code + ("lan" to remoteObject("origins" to JsonArray(emptyList()), "inviteId" to code.getValue("lan").jsonObject.text("inviteId"))))
        val qr = checkNotNull(CentralPairCode.parse(remoteOnly.toString()))
        val credential = pairDesktop(http, qr, "Remote Android")
        assertTrue(DshApiClient(CentralRpcTransport("", http, credential)).sessionList() is RpcResult.Ok)
        assertTrue(unbindDesktop(http, "", credential))
    }

    @Test fun v2ParsingRejectsUnsafeLanAndPreservesLegacyCredential() {
        val key = CentralCrypto.random()
        val base = remoteObject("kind" to "dsh-desktop-pair", "version" to 2, "computerId" to "test_computer", "name" to "Desktop",
            "key" to key, "expiresAt" to System.currentTimeMillis() + 120000)
        for (url in listOf("http://8.8.8.8:1234", "http://127.0.0.1:1234", "http://192.168.2.2:1234/path", "http://name:secret@192.168.2.2:1234")) {
            val qr = JsonObject(base + ("lan" to remoteObject("origins" to JsonArray(listOf(JsonPrimitive(url))), "inviteId" to "test_invitation")))
            assertNull(CentralPairCode.parse(qr.toString()))
        }
        val old = CentralCredential("test_binding", "test_token", key)
        assertEquals(old, CentralCredential.decode(old.encode()))
    }
}
