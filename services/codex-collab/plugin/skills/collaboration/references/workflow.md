# Tool map

| Purpose | Operations |
| --- | --- |
| Local status, recovery diagnosis | `status`, `collab_state`, `collab_identity`, `collab_sync` |
| Browse/search/page | `collab_catalog`, `collab_detail`, `collab_candidates`, `collab_history` |
| Tasks and discussions | `collab_create`, `collab_update`, `collab_reply`, `collab_follow` |
| Notifications | `collab_inbox`, `collab_read` (through cursor or selected event IDs) |
| Unpublished drafts | `collab_draft_get`, `collab_draft_put` (null deletes one draft) |
| Files | `collab_upload`, `collab_download`, `collab_generated_file` |
| Profile and defaults | `collab_profile` |
| Run lifecycle | `collab_start`, `collab_run`, `collab_cancel` |
| Ongoing participation | `collab_attempt_pause`, `collab_attempt_resume`, `collab_attempt_configure`, `collab_attempt_withdraw` |
| Publication and completion | `collab_publish_run`, `collab_validate`, `collab_accept`, `collab_complete` |
| Relay/phone | `remote_state`, `remote_register`, `remote_pair`, `remote_cancel_pair`, `remote_reconnect`, `remote_approve`, `remote_configure`, `remote_revoke`, `remote_unregister` |
| Native Codex | `codex_sessions`, `codex_create`, `codex_prompt`, `codex_cancel`, `codex_rename`, `codex_inspect`, `codex_inputs`, `codex_answer`, `codex_models`, `codex_configure_model`, `codex_select_model` |

The tool schemas are authoritative for arguments. `cli.mjs tools` prints them. The CLI method corresponding to `collab_attempt_resume` is `collab/attempt-resume`.

`collab_start` uses a caller-generated UUID `operationId`. For the same start retry, keep the same task, mode and operation ID. A solve starts one local participation; subsequent rounds use its `attemptId`. A reply run only drafts a discussion reply. `collab_run` can finish an automatic publication already authorized by that run's mode.

Reviewed publication uses `kind=message` or `kind=solution`, a `messageType` of `discussion`, `progress` or `solution`, and the current specification's `baseRevision`. Candidate revision uses `replaces`. Never attach one run's report or generated files to another run.

The worker stores `task.json` in each round's workspace. Native Codex writes `submission.json` and `continuation.json` under that exact round directory. These files are validated by the shared DSH workflow; malformed checkpoints pause work. Earlier rounds remain readable, and their artifacts and execution reports remain unchanged.

CLI examples (use the absolute installed `cli.mjs` path):

```text
node /absolute/plugin/cli.mjs status
node /absolute/plugin/cli.mjs register --relay https://relay.example --code-stdin
node /absolute/plugin/cli.mjs pair --output /private/path/codex-phone.png
node /absolute/plugin/cli.mjs call collab/catalog --json-file /private/path/query.json
node /absolute/plugin/cli.mjs upload /explicitly/selected/file.txt
node /absolute/plugin/cli.mjs download ATTACHMENT_ID --output /new/path/file.txt
node /absolute/plugin/cli.mjs stop
```

`CODEX_COLLAB_HOME` selects the profile. `CODEX_COLLAB_CODEX` selects an installed Codex executable. `CODEX_COLLAB_MODEL` sets an explicit worker model at service startup. Do not change authentication environment variables or copy the user's native authentication into the relay.
