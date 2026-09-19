# DSH 0.1.6-alpha.2 compatibility patch

This bundle applies to the exact official `@deepseek-ai/dsh@0.1.6-alpha.2`
dependency tree and `@earendil-works/pi-ai@0.85.1`. The manifest pins 20 changed
files, the patch, and the unchanged official JSONL persistence implementation.
Unknown bytes and partial application are rejected; original files are backed
up before writing. The original rc.1 bundle is retained for rollback.

The upstream comparison uses release commit
`ddefc45fbc7f8e46dd73185e68295696d1297887` and npm tarballs verified against
their registry integrity hashes. The target files also match a fresh complete
installation byte for byte.

| Behavior | Alpha.2 decision |
| --- | --- |
| Ordinary-session deletion | Keep the Controller-owned Agent disposal, busy/subagent rejection, RPC and client actions, immediate list removal, and workspace cleanup. Official alpha.2 still has no session delete endpoint. Retain the existing `session.lock` inode. |
| MP4 storage and OpenAI transport | Keep byte-preserving storage, admission, previews, and `video_url` conversion. The request-image API now accepts a target rather than the former policy; the MP4 bypass is rebased at this new boundary. This does not add MP4 support to the new DeepSeek Messages adapter. |
| Historical router events | Keep `ignorable` append metadata, the narrow `auto-router/classified` persistence exception, and migration compatibility for that event and `permission/preset.origin`. |
| Headless Session Controller | Keep optional `fileUploads`, conditional receipt binding, and late resolver registration. Official alpha.2 still requires that HTTP service unconditionally. |
| Custom RPC routes | Keep injected HTTP-server registration and disposal/re-registration. Upstream fixed its module/API route lifecycle, but custom channel registration still accesses `owner.webServer` directly. |
| Client default attachment limits | Retire the old `dsh-client-connection/lib/client.js` hunk: alpha.2 removed that fallback list. The installed Host's advertised MP4 admission remains authoritative. |

Alpha.2 generated Typert descriptors use lazy `create` factories. The local
delete endpoint follows that convention in Host, remote-client, and browser
descriptors. The workspace UI changes preserve the official new Session status
sources, retention operations, ordering, and archive behavior.

`apply.mjs` validates every target before modifying any file. Use `--check`,
then `--apply`, and `--verify` against an isolated installation first. Repeated
application verifies the existing checksums without writing again.

Narrow verification:

```sh
node --test tests/core-overlays.test.ts tests/artifact-links.test.ts tests/documentpreview-source.test.ts tests/sidebar-autoclose.test.ts
```

The codec test executes the released Host, remote-client, and browser descriptors
and validates the delete and MP4 result payloads. The desktop integration test
additionally exercises actual Session creation, fork, and deletion against its
isolated fixture Host. Codec acceptance alone does not prove endpoint/model
support for video.

DSH and pi-ai retain their upstream MIT licenses.
