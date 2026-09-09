# dsh-app

<img src="assets/readme/app-icon.png" alt="DSH Desktop app icon" width="96" />

[简体中文](README.md) | English

An independent DeepSeek Harness desktop application for **macOS Apple Silicon** and **Windows x64**.

The app bundles Node.js and the DSH core, with its own Electron main process, React entry point, and Cordis composition. There is no need to start DSH Web beforehand. Sessions, models, tools, approvals, and attachments use DSH's core services and functional components.

## Interface preview

![DSH Desktop main interface with workspace and session details blurred](assets/readme/workspace-blurred.png)

Workspace names and session details are blurred for privacy. The model name remains visible.

## Download and use

Download the package for your platform from [GitHub Releases](https://github.com/yhfgyyf/dsh-app/releases):

| Platform | Package | Installation |
| --- | --- | --- |
| macOS Apple Silicon | `DSH-Desktop-*-macOS-arm64.zip` | Extract the ZIP and move `DSH Desktop.app` to your Applications folder |
| Windows 10/11 x64 | `DSH-Desktop-*-Windows-x64-Setup.exe` | Run the installer; it installs for the current user by default, without administrator privileges |

Open the app, configure your provider and API key in **Settings → Models**, select a workspace, and create a session. Existing DSH users can reuse their configuration in `~/.dsh`, or `%USERPROFILE%\.dsh` on Windows. Node.js and DSH are included in the package and do not require a separate installation.

Each release includes `SHA256SUMS.txt`. Starting with v0.1.1, the macOS package has a complete ad-hoc signature, but it is not signed with an Apple Developer ID or notarized. If macOS blocks the first launch, dismiss the warning, open **System Settings → Privacy & Security**, find DSH Desktop, and click **Open Anyway**. Complete any confirmation requested by macOS. See [Apple's instructions](https://support.apple.com/en-us/102445). The v0.1.0 Mac package had a signature defect; download v0.1.1 or later.

The Windows installer is not code-signed, so Windows may ask you to confirm its source. Uninstalling removes the program while preserving DSH sessions and user configuration.

Starting with v0.1.2, the app offers two automatic check modes: once at each startup (the default), or once daily at a chosen local time while the app is running. Published GitHub previews are included. You can also check from the application menu or **Settings → General → Desktop application**. Choose **Download update**, then **Restart and install** after verification. Wait for running tasks to finish first; sessions, configuration, and a backup of the previous app are preserved. Versions v0.1.1 and earlier require a one-time manual upgrade.

## Features

- Workspace and session lists, history, renaming, branching, deletion, search, and log export.
- Streaming text and reasoning, Markdown, code, tool details, images, and MP4 attachments.
- Model provider configuration, permission approvals, plans, goals, questions, workflows, and subagents.
- Standard, PTC, Minimal, Creative, Auto, and Audit presets; model reasoning effort is configured separately.
- Native menus, file and directory pickers, download saving, zoom, window state, and recovery from core failures.
- Conversation links open in right-sidebar browser tabs; the file sidebar previews HTML/Canvas, SVG, images, and PDFs, with a source-view action.
- Existing file paths in replies open directly, images have thumbnails, and the right sidebar collapses when its last file or browser tab closes.

The app bundles DSH `0.1.5-alpha.1`, Auto Router `0.2.4`, Audit `0.6.1`, and Progressive Tools `0.3.2`. TUI `0.2.0` is used for compatibility testing across the three interfaces and is installed separately into DSH's TUI profile. Exact Git commits are pinned in the [dependency manifest](runtime/dependencies.json).

Some features depend on your model or external tools. MP4 attachments require a provider that supports `video_url`. Audit's Codex and Claude Code backends require their respective CLIs; a DSH model backend can also be configured. The installer does not include model accounts, API keys, or these external CLIs.

## Sharing with Web and TUI

The app, Web, and TUI can share the same `DSH_HOME`, which defaults to `~/.dsh`. Sessions, attachments, workspaces, and model configuration are stored there. The app's own window and port state is stored in the `DSH Desktop` directory under the system's Application Support or AppData folder.

Codex sign-in uses DSH's authorization service and shared credential store. The existing provider refreshes expired tokens. See [build instructions](docs/BUILDING.md) to enable it in Web/TUI. In TUI, use `/login openai-codex` (`--device` for remote terminals), `/auth` for status, and `/logout openai-codex` to sign out. Authorization input is excluded from chat and input history.

The official session lifecycle lock allows only one process to write to a session at a time. Other interfaces receive an ownership error when they try to resume, modify, or delete a session that is in use. They can take over after the owning process exits. Switching pages does not guarantee that a session is released, and following an active stream live across separate processes is not currently supported.

Local patches provide deletion, MP4, and some older-event compatibility. **They do not replace the official session write lock or relax tool-call consistency checks.** Previously corrupted logs may still need separate repair. The patches and their verification manifests are in [patches](patches/dsh-0.1.5-alpha.1).

## Build from source

Install Git, Node.js **24.15.0**, and npm, then run:

```sh
npm ci
npm run setup:runtime
npm run check
npm start
```

`setup:runtime` downloads the pinned DSH version and plugin commits, verifies and applies the patches, and creates an independent `.runtime` directory. It does not read or copy your DSH configuration, credentials, or sessions.

```sh
npm run package          # macOS: requires Swift and iconutil
npm run package:windows  # Windows x64: requires Inno Setup 7
```

For Windows, you can also run **Build Windows installer** manually from the repository's Actions page. The workflow runs checks and compatibility tests, packages the app, verifies silent installation, startup, shutdown, and uninstallation, and makes the build artifacts available for download.

More information: [Building](docs/BUILDING.md) · [Architecture](docs/ARCHITECTURE.md) · [Testing](docs/TESTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md).

This is an independent project, not an official DeepSeek or OpenAI product.
