package com.labteto.dshmobile.ui.screens.main

import android.annotation.SuppressLint
import android.webkit.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.labteto.dshmobile.R
import com.labteto.dshmobile.core.wire.decodeFromJsonElement
import com.labteto.dshmobile.core.wire.dto.*
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.ui.theme.DsTheme
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import org.json.JSONObject
import java.util.UUID

@Composable
internal fun TerminalPanel(store: SessionStore, state: PanelState, modifier: Modifier) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val key = state.key
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var shellMenu by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf<String?>(null) }
    fun operation(block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message }
            finally { busy = false }
        }
    }
    suspend fun refresh() {
        val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
        state.terminals = api.terminalList(key.sessionId).requireValue()
        state.shells = api.terminalShells(key.sessionId).requireValue()
        if (state.terminals.none { it.id == state.selectedTerminal }) state.selectedTerminal = state.terminals.firstOrNull()?.id
    }
    LaunchedEffect(key) { operation { refresh() } }
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            Box {
                TextButton(onClick = { shellMenu = true }, enabled = !busy) { Text(state.shells.firstOrNull { it.path == state.shellPath }?.name ?: stringResource(R.string.terminal_shell)) }
                DropdownMenu(shellMenu, { shellMenu = false }) {
                    state.shells.forEach { shell -> DropdownMenuItem(text = { Text(shell.name) }, onClick = { state.shellPath = shell.path; shellMenu = false }) }
                }
            }
            TextButton(enabled = !busy, onClick = { operation {
                val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
                val info = api.terminalCreate(key.sessionId, TerminalCreateRequest(UUID.randomUUID().toString(), 80, 24, state.shellPath)).requireValue()
                state.selectedTerminal = info.id
                refresh()
            } }) { Text(stringResource(R.string.terminal_new)) }
            TextButton(onClick = { operation { refresh() } }, enabled = !busy) { Text(stringResource(R.string.common_retry)) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error) }
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            state.terminals.forEach { terminal -> TextButton(onClick = { state.selectedTerminal = terminal.id }) { Text(terminal.title) } }
        }
        val terminal = state.terminals.firstOrNull { it.id == state.selectedTerminal }
        if (terminal == null) Text(stringResource(R.string.terminal_empty), Modifier.padding(24.dp))
        else {
            Row {
                TextButton(onClick = { rename = terminal.title }) { Text(stringResource(R.string.common_rename)) }
                TextButton(enabled = !busy, onClick = { operation {
                    store.apiForHost(key.host)?.terminalClose(key.sessionId, terminal.id)?.requireValue()
                        ?: error(context.getString(R.string.common_offline))
                    refresh()
                } }) { Text(stringResource(R.string.common_close)) }
            }
            key(terminal.id) { TerminalScreen(store, key, terminal, Modifier.weight(1f)) }
            rename?.let { title -> AlertDialog(onDismissRequest = { rename = null }, title = { Text(stringResource(R.string.common_rename)) },
                text = { OutlinedTextField(title, { rename = it }) },
                confirmButton = { TextButton(enabled = title.isNotBlank() && title.length <= 120 && !busy, onClick = { operation {
                    store.apiForHost(key.host)?.terminalRename(key.sessionId, terminal.id, title)?.requireValue()
                        ?: error(context.getString(R.string.common_offline))
                    rename = null; refresh()
                } }) { Text(stringResource(R.string.common_save)) } },
                dismissButton = { TextButton(onClick = { rename = null }) { Text(stringResource(R.string.common_cancel)) } }) }
        }
    }
}

private class TerminalBridge(private val receive: (String) -> Unit) {
    @JavascriptInterface fun postMessage(message: String) { if (message.length <= 131072) receive(message) }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun TerminalScreen(store: SessionStore, key: ComposerKey, initial: WebTerminalInfo, modifier: Modifier) {
    val context = LocalContext.current
    val connection by store.connectionState.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var reconnect by remember { mutableIntStateOf(0) }
    var info by remember { mutableStateOf(initial) }
    var writable by remember { mutableStateOf(false) }
    var connected by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var ready by remember { mutableStateOf(false) }
    var environment by remember { mutableStateOf<TerminalEnvironment?>(null) }
    val attachmentId = remember(reconnect) { UUID.randomUUID().toString() }
    val input = remember { Channel<String>(64) }
    val colors = DsTheme.colors
    val background = "#%06x".format(colors.bgBase.toArgb() and 0xffffff)
    val foreground = "#%06x".format(colors.labelPrimary.toArgb() and 0xffffff)
    val view = remember {
        WebView.setWebContentsDebuggingEnabled(com.labteto.dshmobile.BuildConfig.DEBUG)
        WebView(context).apply {
            // Legacy WebViews can lose the containing Compose dialog's surface with GPU drawing.
            if (android.os.Build.VERSION.SDK_INT <= 30) setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null)
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.blockNetworkLoads = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true
            }
            addJavascriptInterface(TerminalBridge { message ->
                scope.launch {
                    val json = runCatching { JSONObject(message) }.getOrNull() ?: return@launch
                    if (json.optString("type") == "ready") ready = true else input.send(message)
                }
            }, "TerminalHost")
            val js = context.assets.open("terminal/xterm.js").bufferedReader().use { it.readText() }
            val fit = context.assets.open("terminal/addon-fit.js").bufferedReader().use { it.readText() }
            val css = context.assets.open("terminal/xterm.css").bufferedReader().use { it.readText() }
            loadDataWithBaseURL("https://terminal.invalid/", """
                <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
                <style>html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden} $css</style></head><body><div id="terminal"></div>
                <script>
                // Android 11 can ship a WebView older than replaceChildren (Chrome 86).
                for (const proto of [Element.prototype,DocumentFragment.prototype]) {
                    if (!proto.replaceChildren) proto.replaceChildren=function(...children){
                        while(this.firstChild)this.removeChild(this.firstChild);
                        for(const child of children)this.appendChild(typeof child==='string'?document.createTextNode(child):child);
                    };
                }
                </script><script>$js</script><script>$fit</script><script>
                const term = new Terminal({fontSize:14,scrollback:1000,disableStdin:true});
                const fit = new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('terminal'));
                function post(value){TerminalHost.postMessage(JSON.stringify(value))}
                function measure(){
                    // Older Android WebViews resolve percentage/vh heights to zero in a dialog.
                    const height=Math.max(1,window.innerHeight)+'px';
                    document.documentElement.style.height=height;document.body.style.height=height;
                    document.getElementById('terminal').style.height=height;
                    const d=fit.proposeDimensions();if(d)post({type:'resize',cols:d.cols,rows:d.rows});
                }
                window.renderFrame=function(frame){if(frame.type==='snapshot'){term.reset();term.resize(frame.info.cols,frame.info.rows);term.write(frame.screen||'')}else if(frame.type==='output')term.write(frame.data||'')};
                window.setWritable=function(value){term.options.disableStdin=!value;if(value){measure();term.focus()}};
                window.setTheme=function(bg,fg){term.options.theme={background:bg,foreground:fg,cursor:fg};document.body.style.background=bg};
                term.onData(data=>post({type:'input',data}));window.addEventListener('resize',measure);post({type:'ready'});
                </script></body></html>
            """.trimIndent(), "text/html", "utf-8", null)
        }
    }
    DisposableEffect(view) { onDispose { input.close(); view.removeJavascriptInterface("TerminalHost"); view.destroy() } }
    LaunchedEffect(ready, background, foreground) {
        if (ready) view.evaluateJavascript("setTheme(${JSONObject.quote(background)},${JSONObject.quote(foreground)})", null)
    }
    LaunchedEffect(ready, writable) { if (ready) view.evaluateJavascript("setWritable($writable)", null) }
    LaunchedEffect(ready, reconnect, connection, store.muxForHost(key.host)) {
        if (!ready) return@LaunchedEffect
        connected = false; writable = false; error = null
        while (input.tryReceive().isSuccess) { /* Discard input from the previous controller. */ }
        try {
            val api = store.apiForHost(key.host) ?: error(context.getString(R.string.common_offline))
            val mux = store.muxForHost(key.host) ?: error(context.getString(R.string.common_offline))
            environment = api.terminalEnvironment(key.sessionId).requireValue()
            var sequence: Long? = null
            mux.openStream("terminal/follow", buildJsonObject {
                put("agentId", JsonPrimitive(key.sessionId)); put("id", JsonPrimitive(initial.id)); put("attachmentId", JsonPrimitive(attachmentId))
            }).collect { raw ->
                val frame = decodeFromJsonElement(TerminalFrame.serializer(), raw)
                if (frame.type == "snapshot") { sequence = frame.sequence; connected = true }
                else if (frame.type == "output") {
                    val next = frame.sequence ?: error(context.getString(R.string.panel_changed))
                    if (sequence == null || next != sequence!! + 1) error(context.getString(R.string.panel_changed))
                    sequence = next
                }
                frame.info?.let { info = it }
                writable = connected && info.state == "running" && info.controllerId == attachmentId
                view.evaluateJavascript("renderFrame(${raw})", null)
            }
            connected = false; writable = false
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = e.message }
        finally { connected = false; writable = false }
    }
    // Hold the terminal open for as long as this tab is on screen.
    //
    // Current-master hosts reclaim a terminal after a couple of hours of confirmed idle unless
    // some window is holding it, and `terminal/follow` deliberately does not count — it is a
    // subscription to the screen, not a claim on the process. Without this a terminal left open on
    // a phone is collected underneath the person while its tab still looks live.
    //
    // The hold is its own stream and carries no data: the first frame is the acknowledgement and
    // the rest of its life is just staying open. A host that predates the endpoint fails the
    // stream instead, which is the same "does not offer that" answer a 404 gives elsewhere and is
    // ignored for the same reason — there is nothing to hold and nothing to tell the person.
    LaunchedEffect(initial.id, attachmentId, reconnect, connection, store.muxForHost(key.host)) {
        val mux = store.muxForHost(key.host) ?: return@LaunchedEffect
        try {
            mux.openStream("terminal/retain", buildJsonObject {
                put("sessionId", JsonPrimitive(key.sessionId)); put("id", JsonPrimitive(initial.id))
            }).collect { /* The stream's existence is the hold; its frames carry nothing to read. */ }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* No retention service composed, or the terminal is already gone. */ }
    }

    LaunchedEffect(input, attachmentId) {
        for (message in input) {
            if (!writable) continue
            val env = environment ?: continue
            val api = store.apiForHost(key.host) ?: continue
            try {
                val json = JSONObject(message)
                when (json.optString("type")) {
                    "input" -> {
                        val data = json.optString("data")
                        if (data.toByteArray(Charsets.UTF_8).size > env.maxInputBytes) error(context.getString(R.string.panel_too_large))
                        api.terminalWrite(key.sessionId, initial.id, attachmentId, data).requireValue()
                    }
                    "resize" -> {
                        val cols = json.optInt("cols").coerceIn(2, env.maxCols)
                        val rows = json.optInt("rows").coerceIn(1, env.maxRows)
                        api.terminalResize(key.sessionId, initial.id, attachmentId, cols, rows).requireValue()
                        view.evaluateJavascript("term.resize($cols,$rows)", null)
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { writable = false; error = e.message }
        }
    }
    Column(modifier.fillMaxWidth()) {
        if (!connected || !writable) Row {
            Text(if (connected) stringResource(R.string.terminal_readonly) else stringResource(R.string.common_offline), Modifier.weight(1f).padding(12.dp))
            TextButton(onClick = { reconnect++ }) { Text(stringResource(if (connected) R.string.terminal_control else R.string.common_retry)) }
        }
        if (info.state != "running") Text(stringResource(if (info.state == "failed") R.string.common_error else R.string.chat_stopped) + " (${info.exitCode ?: "—"})", Modifier.padding(12.dp))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
        AndroidView(factory = { view }, modifier = Modifier.weight(1f).fillMaxWidth())
    }
}
