# Changelog

All notable changes to ShellMind are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and ShellMind follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0 on.

## [1.0.0] - 2026-10-26

The first stable release: a rewrite of the backend into modules, a new security model, and the features that make ShellMind a daily workspace for sysadmins and DevOps engineers. Databases of 0.3.x are migrated on first start.

### Added

**Workspace and organization**
- Server groups, tags, colors, favorites, notes and manual ordering, with a sidebar search over names, addresses, users, groups, tags and OS.
- Command palette (Ctrl+K, Ctrl+Shift+P) for servers, workspace tabs, actions, theme and language.
- Import from `~/.ssh/config` (hosts, `ProxyJump` chains, key files, `IdentityAgent`), and export/import of the whole configuration as JSON without secrets.
- Several servers open at once: recently used servers stay mounted in the background; closing one with unsaved edits, transfers or live terminals asks first.
- Welcome screen with quick actions, recent connections, the servers that need attention and the release highlights.
- English and Spanish interface, detected from the system or chosen in Settings; only the language on screen is loaded.
- Themes: dark, light or system, six accent colors, comfortable and compact density, terminal color schemes, font size and cursor style, a screen reader mode for the terminal.
- Keyboard navigation everywhere: F6 between regions, Ctrl+1...9 for workspace tabs, documented shortcuts in Settings.

**Terminal**
- Several terminal tabs per server sharing one pooled SSH connection with the file manager, the status dashboard and the operations panels; spare connections when the server's `MaxSessions` is reached.
- Split panes (up to four per server) with keyboard and mouse resizing, drag and drop between panes and layouts remembered per server.
- Broadcast input to several terminals of one or more servers, which never forwards a line typed at a password prompt, skips terminals at a password prompt or in a full-screen program, asks before pastes and destructive commands, and records each broadcast line in the audit log.
- Shells inside Docker/Podman containers and Kubernetes pods, hung up when their tab closes.
- Multi-line commands delivered intact to each shell: bracketed paste for bash/zsh, a single runner line for PowerShell that keeps `cd` and variables, line by line elsewhere.
- Commands queued from the chat, snippets and history wait for the session's prompt instead of being lost or typed into a running program.

**Files**
- One file layer for SFTP, FTP/FTPS (explicit and implicit) and S3 with typed request/acknowledgement messages.
- Remote editor (CodeMirror 6) with syntax highlighting, search and conflict detection.
- Bulk download and delete, filter, folder counts before deleting, and downloads streamed to disk.

**Status and fleet**
- Status dashboard redesigned as a dense operations view: CPU, memory, storage, load per core, history charts, network, processes, filesystems, interfaces and failed units, for Linux (including busybox systems) and Windows.
- Fleet health board (Ctrl+Shift+H): reachability checks without logging in, opt-in health checks with jitter, backoff and holds for rejected credentials and changed host keys, jump hosts checked before the servers behind them, alerts and throttled desktop notifications, a health dot per server in the sidebar.

**Operations**
- Operations tab: systemd and Windows services (details, journal, start/stop/restart/reload/enable/disable), Docker and Podman containers (details, stats, logs, actions), Compose projects (up, pull and recreate, restart, stop, down), images and prunes with a preview of the space freed, and live logs from the journal, files, containers and Compose projects.
- Kubernetes workspace: contexts, namespaces, workloads (restart, scale), pods, events, nodes (cordon, uncordon), pod details, logs and shells, on Linux servers with kubectl and on local kubectl consoles.
- Patch center: pending and security updates and pending reboots across apt, dnf, yum, zypper, apk and pacman (Windows Update listed), read from the package caches; patch runs as multi-exec jobs with a canary, a failure limit and an optional reboot that waits for the server and checks its services.
- Disk toolkit: usage explorer, largest files, deleted-but-open files, and cleanups with a preview (journal, package caches, rotated logs, temporary files, core dumps, Docker images, build cache and stopped containers; Windows temporary files, Update cache, recycle bin and component store).

**Remote access**
- Built-in Remote Desktop client (IronRDP, WebAssembly) through an RDCleanPath gateway in the backend: dynamic resolution, scale to fit, full screen with keyboard lock, special keys, text clipboard, Unicode and scancode keyboard modes, sessions through SSH jump hosts.
- Native RDP launch on every platform: `mstsc` on Windows, an `.rdp` file on macOS, `xfreerdp`/Remmina on Linux, or an `.rdp` download.
- SSH tunnels (local port forwarding) per server, started on demand or with the app.
- Jump hosts (`ProxyJump`), in chains, for every feature that connects to a server.
- Known hosts manager listing each pinned key with its jump route and the servers using it.

**Identities and keys**
- Identities shared by many servers (password, private key with passphrase, or SSH agent), assigned in bulk; credentials saved on a server take precedence.
- SSH agent support: `SSH_AUTH_SOCK`, the Windows OpenSSH agent pipe and Pageant; agent forwarding per server, off by default.
- ed25519 key generation, installing a public key on many servers (checked by signing in with it), and safe key rotation that also removes the previous key from the servers once all of them accept the new one.

**Snippets, multi-exec and audit**
- Snippet library with `{{variables}}`, global or per server; secret variables masked in every record.
- Multi-exec as background jobs with history: rolling batches, canary with approval, failure limit, pause, resume, cancel, output grouped by result with a diff view, export, and "run again where it failed".
- Audit log of every command the app runs or types (AI runs and Auto-Run steps, snippets, multi-exec, operations, Kubernetes, patching, cleanups, broadcast lines, container and pod shells, identity installs, fleet settings, RDP sessions), with search and a retention setting.

**AI assistant**
- Current models: MiniMax M3 (default) and M3.1 Flash, Gemini 3.8 Flash, Gemini 3.5 Flash-Lite and Gemini 4 Argon, each with a fallback model; retired model ids map to their successors.
- MiniMax with your own key goes directly to MiniMax's API; without one, through the new ShellMind proxy. The chat discloses the route and what is sent before the first request.
- Diagnose with AI from services, containers, pods, selected log lines, the status page and the fleet board, with evidence collected server-side, shown to you before it is sent, and answers structured as cause, evidence and fix; one-click triage of a server.
- Auto-Run that waits for the shell prompt, fixes failed commands itself, stops after five steps, and never runs a destructive command or a diagnosis fix without approval.

**Desktop, self-hosting and tooling**
- Desktop app: backend supervised on a random loopback port with a per-launch token, restarted after a crash; single instance; renderer crash recovery; title bar following the theme; a way out when the data key cannot be read.
- Self-hosted web mode (`npm run build && npm run serve`): the backend serves the UI from the same origin, compressed, with an access token screen.
- Test suites: unit, integration against the real backend and an in-process SSH server, component tests, contract tests, opt-in Docker and browser end-to-end suites, every Windows feature over a real OpenSSH server, and an end-to-end UI suite (Playwright) that drives the whole app against sshd containers.
- CI on Windows, Debian 12 with npm 12 (coverage floors) and Node 22, with packaged-app smoke tests on Windows and Linux and a weekly macOS package.
- Installers for every platform from one version tag: Windows (NSIS, x64), Linux (AppImage and `.deb`, x64, built against glibc 2.31 so they run on Debian 11, Ubuntu 20.04, Fedora, RHEL 9 and newer) and macOS (dmg and zip for Apple silicon and Intel, signed ad hoc so Apple silicon starts them), each smoke-tested as it ships (including that it was built from the tagged commit) and attached to a draft GitHub release with `SHA256SUMS.txt` and a signed build provenance (`gh attestation verify`). The packages are built with read-only repository access; only the publishing step can write to the release.

### Changed

- The backend is split from one `server.ts` into modules under `server/` and `shared/`, with typed socket events, one error envelope (`{error, code, details}`) and a structured logger.
- Connections go through a pooled SSH layer with keepalive, idle close, bounded command output, channel limits per connection and jump-host deadlines.
- The status dashboard runs one script per refresh on the pooled connection instead of opening its own sessions.
- Terminal output is binary-safe UTF-8, batched and flow-controlled, so a flood can neither fill memory nor bury Ctrl+C.
- Scripts for Windows servers reach PowerShell on the standard input of one fixed command line (`powershell -NoProfile -NonInteractive -Command -`) instead of a long `-EncodedCommand` argument, which Microsoft Defender flagged as obfuscated PowerShell; `SHELLMIND_POWERSHELL_DELIVERY=encoded` keeps the old way for SSH servers that do not pass stdin on.
- Uploads go to a temporary file moved into place at the end; downloads stream to disk; S3 checksums are sent to custom endpoints only where required.
- MiniMax traffic without a user key goes to the new proxy at `ai-proxy.luisbh.com`; the Gemini integration moved to the `@google/genai` SDK.
- Chat: streamed answers parse only the growing block, restored conversations render progressively, stopped answers stay partial after a reload, SSE heartbeats keep slow answers alive behind proxies.
- Node.js 24.15 or later (or 22.22.2 or later in the 22 line) is required; dependencies were updated and trimmed, and the desktop package excludes build-only files.

### Fixed

- The status dashboard on busybox systems, Alpine without utmp, containers (overlay root) and Windows drives other than C:.
- Large uploads and downloads, deletions on MinIO and other S3-compatible services, FTP transfers with separate data connections, and in-place replacements on read-only folders.
- The editor survives disconnects and server switches; an editor that cannot load no longer takes the file manager down.
- Live logs pause the remote command while the browser lags instead of dropping lines, and follow files in the home directory.
- Multi-line blocks reach PowerShell, cmd.exe and bash intact; prose after a code block is never run.
- Windows servers signed in with an account that is not an administrator: the status dashboard timed out, the services list was empty, services the account may not query were reported missing, the fleet check never finished and the diagnosis evidence claimed there were no errors. Without WMI (which Windows keeps for administrators over SSH) they now read what the account may read and say what is missing; a refused service action is reported as refused, and Windows Update refusing the search is its own notice.
- The Windows uptime is computed in UTC, so it is no longer an hour off after a daylight saving change.
- The built-in Remote Desktop of the desktop app connects to Windows servers that present their default self-signed certificate. Electron's TLS library refused it (`RDP_TLS_FAILED` ... `KEY_USAGE_BIT_INCORRECT`) because its key usage does not allow digital signatures. The gateway now connects again with TLS 1.2 and RSA key exchange, keeps that connection only when its certificate really needs it (so an attacker in the middle cannot force it on a server whose certificate allows digital signatures), still checks the pinned certificate, and records in the audit log which sessions have no forward secrecy (see SECURITY.md).
- Connection states in the header, sidebar and chat reflect the real session; connection failures are explained in the user's language.
- Dozens of accessibility fixes: focus management in dialogs, visible focus rings, keyboard-operable tabs, menus and dividers, labels for every control, and contrast in both themes.

### Security

- A session token is required by every API request and socket connection (only `GET /api/health` is public), compared in constant time. The desktop app and `npm start` create one per launch; a self-hosted backend prints one or uses `SHELLMIND_AUTH_TOKEN`.
- The backend binds to `127.0.0.1` by default and refuses (403) requests whose `Host` is not loopback or listed (DNS rebinding) and browser origins that are not loopback or listed, on HTTP, socket.io and the RDP gateway.
- The built UI runs under a Content-Security-Policy that only allows its own scripts (plus WebAssembly compilation for the RDP client) and connections to its backend.
- Electron hardening: sandboxed renderer with context isolation and no Node integration, a permission allowlist (clipboard, notifications, full screen, keyboard lock), no navigation or new windows inside the app, and fuses that disable `NODE_OPTIONS` and the inspector and enforce `app.asar` integrity.
- Credentials (passwords, private keys, passphrases, S3 secret keys, AI keys) are encrypted at rest with AES-256-GCM; existing plaintext values are encrypted on first start. The desktop app keeps the data key in the OS keychain.
- Connection targets always come from the database row of the saved server; the client never supplies a host for stored credentials, and ad-hoc local connections are refused.
- SSH host keys are pinned on first use per host, port and jump route; RDP server certificates are pinned the same way; a mismatch stops the connection and shows both fingerprints.
- Secrets never reach the browser, with one documented exception: the RDP password is handed to the built-in client once per connection (or typed each time).
- A destructive-command gate parses commands structurally before the AI, Auto-Run, snippets or multi-exec type them; terminal and command output reaches the AI inside delimited untrusted-data blocks, with known secret formats masked.
- Configuration imports cannot link saved credentials to the hosts they name without the user's consent.
- Shells and CLIs spawned locally never inherit ShellMind's own secrets from the environment.
- PowerShell scripts are built from validated input only, as printable ASCII with every other character (typographic quotes included) spelled as a `[char]` code, and by default reach the server on standard input, never on its command line.
- `npm audit` reports no known vulnerabilities in the shipped dependencies.

### Removed

- The old embedded RDP canvas (rdpjs), which needed a missing patch; replaced by the IronRDP client.
- The `@google/generative-ai` SDK (replaced by `@google/genai`), the Gemma and Gemini 2.5/3 preview models, and MiniMax M2.5/M2.7 (saved preferences move to their successors).
- The old AI proxy host and the client-side handling of connection secrets.

## [0.3.3] - 2026-06-11

### Security
- Resolved all known dependency advisories (`npm audit`: 41 to 0), including `basic-ftp` (path traversal), `socket.io-parser`, `ws`, `engine.io`, `express`/`path-to-regexp`/`qs` and `node-forge`.
- Upgraded `sqlite3` 5 to 6 (prebuilt binaries) and the dev-only `concurrently` 9 to 10. No application code changes.

## [0.3.2] - 2026-06-11

### Added
- MiniMax M3 with automatic fallback to M2.7 and a larger reasoning budget.
- Multi-turn conversation context for MiniMax and Gemini; conversations saved per server, with a clear button.
- Live streaming answers over SSE; Stop cancels the upstream request.

### Changed
- In scoped CLI consoles the AI emits bare subcommands, and pasted `tool>` prompts are normalized.
- Auto-Run waits for the terminal to go quiet (up to 45 s) instead of a fixed 4 s.
- The off-topic filter only applies to the first message of a conversation.
- The backend port can be set with `PORT`.

### Security
- Connection secrets no longer leave the backend: the UI connects by server id and `GET /api/servers` returns `has_*` flags instead of secrets.
- Origin allowlist on the HTTP API and the socket (`ALLOWED_ORIGINS` for custom web origins); credential-free server logs; "leave blank to keep" for saved secrets.

## [0.3.1] - 2026-06-10

### Fixed
- Large uploads no longer stall: uploads stream in acknowledged chunks with per-file progress, over SFTP, FTP and S3 (multipart, no 5 GB cap).

## [0.3.0] - 2026-06-10

### Added
- Local CLI connections: scoped consoles for Azure, AWS, Google Cloud, Kubernetes and Docker CLIs, a system shell through `node-pty`, and a custom command mode.
- Terminal clipboard (Ctrl+V, Ctrl+Shift+V, right-click, middle-click, Ctrl+Shift+C), a context menu, and a connection indicator with one-click reconnect.
- File manager: drag and drop multi-file upload with progress, breadcrumb navigation, multi-select bulk delete, file-type icons.
- AI chat: stop, copy, regenerate, better code blocks.
- A unified dark design system with toasts and in-app confirmations; a macOS Edit menu.

### Changed
- The status dashboard samples `/proc/stat`, uses POSIX `df`, and degrades per metric, so it works on minimal images such as Alpine.

## [0.2.0] - 2026-03-27

### Added
- MiniMax M2.7 through the Anthropic-compatible API, the default model, free through the ShellMind proxy during the alpha.
- Separate Gemini and MiniMax keys in Settings, editable or removable when not set by environment variables.
- A visual Status dashboard for CPU, memory, storage, uptime and top processes.

### Removed
- The floating SSH issue warning in the chat.

## [0.1.9] - 2026-03-21

### Added
- Terminal search and clickable URLs; SSH error lines highlighted in the terminal.
- Create-folder and rename dialogs in the file explorer.

### Changed
- AI hints, terminal controls, Auto-Run confirmation and SSH error analysis refined.

## [0.1.8] - 2026-03-21

### Added
- SSH issue detection and the "Fix it" workflow.

### Removed
- The embedded RDP client was disabled; Windows servers open in the native RDP client.

## [0.1.5] - 2025-12-25

### Added
- SSH private key authentication.
- A custom app icon; desktop fixes for the model selector, the Auto-Run button and chat input focus.

## [0.1.4] - 2025-12-21

### Added
- S3 and S3-compatible storage (MinIO, R2...) in the file explorer.

## [0.1.3] - 2025-12-20

### Added
- Gemini 3 Flash preview and a saved model preference.

## [0.1.2] - 2025-12-13

### Added
- FTP connections with a virtual shell.

## [0.1.1] - 2025-12-07

### Added
- Several AI models with automatic fallback, server search and delete, UI improvements.

## [0.1.0] - 2025-12-06

### Added
- First alpha: a web and Electron app with SQLite storage, SSH and PowerShell terminals, SFTP file management, a Windows status view and an AI assistant (Gemini) with Auto-Run.

[1.0.0]: https://github.com/Luisbh-dev/shellmind/releases/tag/v1.0.0
[0.3.3]: https://github.com/Luisbh-dev/shellmind/commit/ef60ea8567c6c37a62d3480740fe65ebe96325b6
[0.3.2]: https://github.com/Luisbh-dev/shellmind/commit/6764af5c8bf6c5d9d8e05757d12acc0cf3ef67fd
[0.3.1]: https://github.com/Luisbh-dev/shellmind/releases/tag/v0.3.1
[0.3.0]: https://github.com/Luisbh-dev/shellmind/releases/tag/v0.3.0
[0.2.0]: https://github.com/Luisbh-dev/shellmind/releases/tag/v0.2.0
[0.1.9]: https://github.com/Luisbh-dev/shellmind/commit/54e6616e62c7768e84c49e1cf6b244398e9f4b43
[0.1.8]: https://github.com/Luisbh-dev/shellmind/commit/2266ddf7d754e106d3e9a3bfb32bd6eb7ade961e
[0.1.5]: https://github.com/Luisbh-dev/shellmind/commit/0e44c6a53f388458a5d0de8a043bcf93c1cdc5b8
[0.1.4]: https://github.com/Luisbh-dev/shellmind/commit/0a7800ded81583cf1bbc9726f0d12a32009a1e0a
[0.1.3]: https://github.com/Luisbh-dev/shellmind/commit/6fbd7bae23abb0d3ed1f69906f91944a7dbf74c2
[0.1.2]: https://github.com/Luisbh-dev/shellmind/commit/89f424c77d83b6b2be0eb61c3374839c33f25494
[0.1.1]: https://github.com/Luisbh-dev/shellmind/commit/a056bc4a3cd59014e51ff44a5e099271feb5cbf2
[0.1.0]: https://github.com/Luisbh-dev/shellmind/commit/8a53a6136cd4f6d86289934b057cbc1c23725e94
