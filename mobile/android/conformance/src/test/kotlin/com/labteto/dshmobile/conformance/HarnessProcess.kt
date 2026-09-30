package com.labteto.dshmobile.conformance

import java.io.File
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * A real DeepSeek Harness, booted from source for the duration of one test class.
 *
 * This is the whole point of the module. Every other suite in this repository checks the client
 * against a description of the harness — hand-written DTOs, a hand-curated fixture, or
 * `:mock-harness`, which is a Kotlin re-implementation written by reading upstream. A misreading is
 * invisible to all three, because the same misreading is on both sides of the assertion. Here the
 * other side is the harness itself.
 *
 * ## Finding a checkout
 *
 * `DSH_HARNESS_SRC`, else a sibling directory, else the path this was developed against. The
 * checkout must be **built** (`pnpm run build:lib`): workspace packages resolve to `lib/index.js`,
 * which is build output, and without it the web profile fails to import about 117 plugins and never
 * serves anything. [available] checks for that rather than letting a test fail with a wall of
 * module-resolution noise.
 *
 * ## Determinism
 *
 * The harness talks to whatever `DEEPSEEK_BASE_URL` names, so [MockModel] points it at the
 * harness's own scriptable SSE server (`packages/test-support/llm-mock-server`). A turn therefore
 * runs for real — a real agent loop, a real session log, real projections — without a paid model or
 * a network. That is what makes it possible to check live streaming, tool approvals and feedback on
 * a fresh reply, all of which the 0.11.0 validation had to record as unverified.
 */
class HarnessProcess private constructor(
    /** Origin to address the harness at, e.g. `http://127.0.0.1:34567`. */
    val baseUrl: String,
    /** The one-shot launch token the harness printed; exchange it for a browser session. */
    val launchToken: String,
    private val process: Process,
    private val home: File,
    private val workspace: File,
    private val model: MockModel?,
) : AutoCloseable {

    /** A disposable directory the harness may use as a session workspace. */
    val workspacePath: String get() = workspace.absolutePath

    override fun close() {
        process.destroy()
        if (!process.waitFor(GRACE_SECONDS, TimeUnit.SECONDS)) process.destroyForcibly()
        model?.close()
        home.deleteRecursively()
        workspace.deleteRecursively()
    }

    companion object {
        private const val GRACE_SECONDS = 10L
        private const val READY_TIMEOUT_SECONDS = 180L
        private const val LIB_MARKER = "packages/api/gateway/lib/index.js"
        private const val CLI_ENTRY = "apps/cli/src/bin.ts"

        /** The launch line the web profile prints exactly once, carrying a fresh token per process. */
        private val READY_LINE = Regex("""dsh web: (http://\S+)""")

        /**
         * The harness checkout to run, or null when there is nothing usable.
         *
         * Null is the ordinary case on CI and on a machine that only builds the app, so callers
         * skip rather than fail. A checkout that exists but has not been built is also null, with
         * the reason printed once — that is a setup problem worth saying out loud, because the
         * failure it would otherwise cause looks like a protocol fault.
         */
        fun checkout(): File? {
            // An explicitly named checkout is authoritative: if someone sets DSH_HARNESS_SRC and it
            // is wrong, they want to hear that, not to have a different harness quietly substituted
            // and a green result that says nothing about the one they meant.
            val named = System.getenv("DSH_HARNESS_SRC")
            val roots = when {
                named.isNullOrBlank() -> listOf("../deepseek-harness", "../../deepseek-harness", "G:/LAB/deepseek-harness")
                else -> listOf(named)
            }.map(::File)
            val present = roots.firstOrNull { File(it, CLI_ENTRY).isFile } ?: return null
            if (!File(present, LIB_MARKER).isFile) {
                println(
                    "conformance: ${present.absolutePath} is not built; run `pnpm run build:lib` " +
                        "there (packages resolve to lib/, which is build output). Skipping.",
                )
                return null
            }
            return present
        }

        /** Whether a booted harness is possible here at all. */
        fun available(): Boolean = checkout() != null && node() != null

        /** The `node` executable, or null when it is not on `PATH`. */
        fun node(): String? {
            val names = if (isWindows()) listOf("node.exe", "node.cmd", "node") else listOf("node")
            val path = System.getenv("PATH")?.split(File.pathSeparator).orEmpty()
            for (dir in path) for (name in names) {
                val candidate = File(dir, name)
                if (candidate.isFile) return candidate.absolutePath
            }
            return null
        }

        private fun isWindows(): Boolean =
            System.getProperty("os.name").orEmpty().lowercase().contains("win")

        /** A port nothing is listening on. Reserved then released, because `--port` needs a number. */
        fun freePort(): Int = ServerSocket(0).use { it.localPort }

        /**
         * Whether this checkout's DeepSeek adapter still takes a `protocol` setting.
         *
         * Harness 0.1.7 speaks only the Messages API and refuses the whole profile at load when
         * the key is present at all ("protocol is not configurable"); its mock model server moved
         * to the same API, so no setting is needed. Read off the source rather than a version
         * string, since a checkout carries no version the harness reports.
         */
        private fun namesItsProtocol(root: File): Boolean {
            val config = File(root, "packages/llm/llm-deepseek/src/config.ts")
            return !config.isFile || !config.readText().contains("protocol is not configurable")
        }

        /**
         * Boot a harness and wait for it to announce itself.
         *
         * @param model a scriptable model server to point the harness at, or null to leave it with
         *   a fake key and no base URL — enough to boot and serve, but not to run a turn.
         */
        fun start(model: MockModel? = null): HarnessProcess {
            val root = requireNotNull(checkout()) { "no harness checkout; call available() first" }
            val node = requireNotNull(node()) { "node is not on PATH" }
            val port = freePort()
            val home = createTempDir("dsh-home")
            val workspace = createTempDir("dsh-workspace")

            if (model != null && namesItsProtocol(root)) {
                // Through 0.1.6 the provider's protocol had to be named, or the adapter picked its
                // own default and the mock server answered a shape the harness would not read.
                File(home, "settings.yaml").writeText("llm-deepseek:\n  protocol: chat-completions\n")
            }

            val command = listOf(
                node, "--import", tsxLoaderHref(root, node),
                File(root, CLI_ENTRY).absolutePath,
                "web", "--no-open", "--port", port.toString(),
            )
            val builder = ProcessBuilder(command)
                .directory(workspace)
                .redirectErrorStream(true)
            builder.environment().apply {
                // Anything that looks like a credential belongs to the developer, not to a harness
                // this test is about to point at a mock server.
                keys.removeAll { it.contains(Regex("(?i)KEY|SECRET|TOKEN|PASSWORD")) }
                put("DSH_HOME", home.absolutePath)
                put("DSH_AGENTS_HOME", File(home, "agents").absolutePath)
                put("DSH_TELEMETRY_DISABLED", "1")
                put("NODE_NO_WARNINGS", "1")
                put("TSX_TSCONFIG_PATH", File(root, "tsconfig.json").absolutePath)
                put("DEEPSEEK_API_KEY", model?.apiKey ?: "conformance-no-model")
                if (model != null) put("DEEPSEEK_BASE_URL", model.baseUrl)
            }

            val process = builder.start()
            val launchUrl = AtomicReference<String>()
            val reader = Thread {
                process.inputStream.bufferedReader().forEachLine { line ->
                    READY_LINE.find(line)?.let { launchUrl.compareAndSet(null, it.groupValues[1]) }
                }
            }
            reader.isDaemon = true
            reader.start()

            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(READY_TIMEOUT_SECONDS)
            while (launchUrl.get() == null && System.nanoTime() < deadline) {
                check(process.isAlive) { "harness exited before announcing itself" }
                Thread.sleep(POLL_MS)
            }
            val url = launchUrl.get()
            if (url == null) {
                process.destroyForcibly()
                home.deleteRecursively()
                workspace.deleteRecursively()
                error("harness did not print its launch line within ${READY_TIMEOUT_SECONDS}s")
            }

            val token = Regex("token=([A-Za-z0-9_-]+)").find(url)?.groupValues?.get(1)
                ?: error("launch line carried no token")
            return HarnessProcess(
                baseUrl = url.substringBefore("/?"),
                launchToken = token,
                process = process,
                home = home,
                workspace = workspace,
                model = model,
            )
        }

        private const val POLL_MS = 100L

        /**
         * The tsx ESM loader, as a file URL.
         *
         * Asked of node rather than guessed, because pnpm puts it under a versioned `.pnpm`
         * directory whose name changes with every bump.
         */
        private fun tsxLoaderHref(root: File, node: String): String {
            val probe = ProcessBuilder(
                node, "-e",
                "console.log(require('url').pathToFileURL(require.resolve('tsx')).href)",
            ).directory(root).redirectErrorStream(true).start()
            val out = probe.inputStream.bufferedReader().readText().trim()
            check(probe.waitFor(30, TimeUnit.SECONDS) && probe.exitValue() == 0) {
                "could not resolve tsx in ${root.absolutePath}: $out"
            }
            return out.lines().last { it.startsWith("file:") }
        }

        private fun createTempDir(prefix: String): File =
            File.createTempFile(prefix, "").let { file ->
                file.delete()
                file.mkdirs()
                file
            }
    }
}
