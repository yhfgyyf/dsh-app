# DSH Mobile 0.11.0 validation

Date: September 15, 2026. App version code: `1100`; debug application ID:
`com.labteto.dshmobile.debug`. Minimum Android API: 26.

## Target and build

Harness release `0.1.6-alpha.1`, with master pinned to
[`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/commit/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720).
The exact detached checkout was installed with its frozen lockfile, built, and launched
through `dsh web` with a separate `DSH_HOME` and disposable workspace. No model API key
was provisioned. The relay repository and public releases were not changed.

The following tasks passed together on the final implementation:

```text
:core:test
:mock-harness:test
:app:testDebugUnitTest
:app:lintDebug
:app:assembleDebug
:app:connectedDebugAndroidTest
```

| Suite | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| Core JVM | 149 | 0 | 0 |
| Mock harness JVM | 25 | 0 | 0 |
| App JVM | 181 | 3 | 0 |
| Android 11 instrumentation | 4 | 0 | 0 |

The three skipped app tests are the opt-in real-relay conformance tests. They require
an external relay fixture. Mock relay transport/authentication tests ran normally.
Lint completed successfully; this does not mean the repository has zero warnings.

## Protocol and regression coverage

- Pinned V3 fixtures preserve raw metadata and append-origin conversation history,
  derive replacement ranges separately, and project image offload without mutating
  original records. Partial ranges and replacements of replacements are covered.
- Existing assistant stream tests cover live snapshots, settlement deduplication,
  reconnect prefixes and history behavior. A paid model streaming session was not run.
- Contract tests cover the separate permission catalog, optional preset document field,
  mode-selection flag, explicit subagent delivery, nested workspace reconnect baseline,
  restore arguments, feedback creation/conflict/retraction, file paging/version fields,
  terminal attachment IDs and recovery frames.
- Mock-backed HTTP tests exercise archive restore, file reads, feedback compare-and-set
  failures and terminal controller rejection, rename and close.
- Image tests cover bounded reads, count/byte admission including existing images,
  mixed valid/invalid admission order, corrupt decode, thumbnail bounds, picker
  cancellation, send blocking during preparation, composer isolation and rejected-send
  attachment restoration. These combine JVM and instrumentation checks; they are not
  a complete gallery-provider/device matrix.
- Native composer regression checks retain attachments across session switches and
  preserve newly entered attachments when a rejected send is restored.
- Diff tests preserve unchanged context and handle creation/deletion. Preview path
  tests cover relative references and Windows/POSIX host paths.

## Live direct connection on Android 11

Used the API 30 emulator with its older DocumentsUI image picker. The app connected
through ADB reverse to the pinned host on port 3089, using the real root launch-token
exchange and browser-session cookie. No authentication bypass was used.

| Flow | Observed result |
| --- | --- |
| First manual host sign-in | Passed; fixed saving the attempted host before opening its sign-in dialog |
| Two-photo gallery selection | Both photos staged in returned order |
| One send with both photos | Exactly one image-bearing `user/message` in the V3 log, with two distinct attachments; both SHA-256 digests match the source photos in picker order |
| Model response to that prompt | Host accepted the turn, then reported the expected missing-model-API-key error |
| Permission catalog | Host advertised three presets; Auto review was absent and not offered |
| Workspace file listing | Real authenticated list/read endpoints succeeded |
| HTML preview | Heading and related PNG rendered; the embedded script that would replace the document with `UNSAFE` did not run |
| PDF preview | Authenticated one-page PDF rendered with page controls |
| Archived sessions | Settings showed the archived session, workspace path and update time; Restore removed it from the archived section |
| Terminal | Native creation and recovered attachment to a retained cmd terminal succeeded; keyboard input executed `echo DSH_NATIVE_OK`, and output appeared in xterm |

Old-WebView checks exposed two rendering issues, both fixed: missing `replaceChildren`
and zero percentage/viewport heights inside the Compose dialog. API 30 uses software
WebView drawing to preserve surrounding native controls. HTML and terminal WebViews
remain separate, with no native bridge in document previews.

## Validation limits

- No live relay was configured. The three opt-in relay tests were skipped; direct
  connection results must not be interpreted as live-relay validation.
- No model credentials were added. Live assistant streaming, actual subagent execution,
  and feedback against a newly generated assistant reply remain unverified. Protocol
  and mock coverage is available for these contracts.
- Terminal reopening/recovery and native input were exercised. Concurrent-client
  controller takeover and a confirmed network-loss recovery were not fully exercised.
- Gallery cancellation, corrupt decoding, limit admission and session ownership have
  automated coverage. Unreadable third-party providers, every mixed-provider batch,
  physical phones, all supported Android versions, and the complete RTL/theme matrix
  were not exhaustively exercised.
- An additional API 37 preview emulator could not run Espresso: its input injection
  failed with `NoSuchMethodException: android.hardware.input.InputManager.getInstance`.
  The same four instrumentation tests passed on stable Android 11.
- Drafts, preview tabs and directory positions survive navigation within the app process;
  they are not durable across Android process death. Binary previews retain at most
  32 MiB per selected document, text previews at most 4 Mi characters per tab, with
  host limits enforced by the host. Unsupported files retain their path and host-open action.

## Local delivery

- APK: `build/delivery/DSH-Mobile-0.11.0-debug.apk` (debug signed, not a public release).
- SHA-256: `597294ddb7f5cac9b9297b9443629d992985e54337dad224ab6fb1197e7a92ba`.
- Machine-readable results and checksum: `build/delivery/validation.json` and
  `build/delivery/SHA256SUMS.txt`.
- Native screenshots: `build/delivery/terminal-input.png`, `pdf-preview.png`,
  `html-preview.png`, and `archive-before.png`.
- Gradle reports: `core/build/reports/tests/test`, `mock-harness/build/reports/tests/test`,
  `app/build/reports/tests/testDebugUnitTest`, `app/build/reports/androidTests/connected`,
  and `app/build/reports/lint-results-debug.html`.

Build outputs and disposable-host logs are intentionally not tracked in Git. Host logs
contain private launch credentials and are not part of the delivery bundle.
