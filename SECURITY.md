# Security policy

ShellMind holds the keys to your servers: SSH passwords and private keys, RDP passwords, S3 secret keys and AI API keys, and it types commands into production shells. This document explains how it protects them, what it sends where, what it cannot protect against, and how to report a vulnerability.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes: security fixes are released as 1.0.x updates. |
| 0.3.x and earlier | No. These versions have a weaker security model (no session token, credentials in plaintext); upgrade to 1.0. |

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- through GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/Luisbh-dev/shellmind/security/advisories/new), or
- by email to **contact@luisbh.com** with "ShellMind security" in the subject.

Include the version (Settings > About), the platform (desktop app on Windows/macOS/Linux, or self-hosted web), the steps to reproduce, and what an attacker gains. You will get an acknowledgement as soon as possible, normally within a week, and a fix or a mitigation plan once the report is confirmed. Reporters are credited in the release notes unless they prefer otherwise. Please give us a reasonable time to release a fix before disclosing the issue.

## Security model

### Who is trusted

ShellMind is a **single-user** tool. Whoever holds the session token (or runs the desktop app on your account) can use every saved server with its stored credentials, read and write their files, and run commands on them. There are no user accounts or roles. The machine that runs the backend is trusted: the local consoles run there as the backend's user, and the database and its key live there.

### Session token

- Every HTTP request except `GET /api/health` (which only returns the version) and every socket.io handshake must carry the session token, as `Authorization: Bearer <token>` or in the socket's `auth` payload. Tokens are compared in constant time.
- The **desktop app** generates a new random token at each launch, starts its backend with it, and hands it to its own window in the launch URL, which the page removes from the address bar and keeps in session storage.
- **`npm start`** generates a token per run and passes it to the Vite dev server, which writes it into the page it serves (never into a script another site could load); the dev server sends no CORS headers.
- A **self-hosted** backend uses `SHELLMIND_AUTH_TOKEN`, or generates a token and prints it once at startup. The browser keeps it for the session, or in local storage only if the user ticks "Remember on this device". Use at least 32 random characters.
- The embedded Remote Desktop gateway, a WebSocket that browsers cannot give an `Authorization` header, accepts one-time tickets instead: issued over the authenticated socket, bound to one saved server and to the socket that asked, valid for 30 seconds, usable once.

### Network exposure

- The backend listens on `127.0.0.1` by default. Listening anywhere else prints a warning: put a TLS reverse proxy in front.
- **Host check**: requests whose `Host` header is not a loopback name or listed in `ALLOWED_HOSTS` (or the host of an `ALLOWED_ORIGINS` entry) are refused with 403. This defeats DNS rebinding, where a hostile site resolves its own name to `127.0.0.1`.
- **Origin check**: requests from browser origins other than loopback, the backend's own origin, or `ALLOWED_ORIGINS` are refused with 403 (not just left without CORS headers, so a cross-site request cannot run for its side effects). `Origin: null` is refused, except by the desktop app's backend, whose page is a `file://` URL.
- The same checks guard the socket.io handshake (polling and WebSocket upgrades) and the RDP gateway.
- Responses carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on the API. Request bodies are limited (1 MB, 8 MB for the chat and configuration imports). Errors never include stack traces.

### The user interface

- The built UI carries a strict **Content-Security-Policy**: scripts only from the app itself plus one inline theme script allowed by its hash, `'wasm-unsafe-eval'` for the WebAssembly RDP client (which still forbids `eval`), connections only to the app, loopback and `VITE_API_BASE`, images from the app, `data:` and `blob:`, no plugins (`object-src 'none'`).
- Nothing third-party is loaded at runtime: fonts and every library are bundled.
- Terminal output, file names and log lines are rendered as text, and AI answers as Markdown without raw HTML.

### The desktop app

- The window runs with `sandbox`, `contextIsolation` and `webSecurity` on and `nodeIntegration` off.
- Web permissions are denied except the clipboard, notifications (fleet alerts), full screen and keyboard lock (the Remote Desktop tab).
- The window never navigates away from the app or opens new windows: links go to the system browser, `<webview>` is refused.
- Electron fuses disable `NODE_OPTIONS` and the `--inspect` flags, enable cookie encryption, and enforce `app.asar` integrity and loading the app only from `app.asar`. (`runAsNode` stays on: the backend runs as a child process of the app's own executable.)
- The backend runs as a supervised child process on a random loopback port, restarted after a crash with a new port. Its log (`server.log` in the app's data folder) masks session tokens.
- Only one instance runs per data folder.

### Credentials at rest

- Passwords, private keys, passphrases, S3 secret keys, identity secrets and AI API keys are encrypted in the database with **AES-256-GCM**, stored as `enc:v1:<iv>:<tag>:<ciphertext>`. Values written in plaintext by older versions are encrypted at the first start of 1.0.
- The 32-byte **data key** comes from `SHELLMIND_DATA_KEY`, or from `shellmind.key` next to the database (created with mode 0600). The desktop app keeps it in its data folder encrypted with the OS keychain (DPAPI on Windows, the Keychain on macOS, the Secret Service or KWallet on Linux; without any keyring, a file only your user can read). The backend removes the key and the session token from its environment as soon as it has read them.
- **Back up the data key together with the database.** A database without its key cannot be decrypted by anyone; ShellMind refuses to start rather than silently create a new key for a database that holds encrypted credentials. Starting over with a new key (`SHELLMIND_RESET_DATA_KEY=1`, or "Start over" in the desktop app) clears the saved credentials and keeps everything else.
- The database and the key file are as sensitive as the credentials: keep them readable only by the user that runs ShellMind, and protect backups accordingly.
- **Secrets never reach the browser.** The API returns `has_password`-style flags, never values; edit forms keep a saved secret unless it is replaced or explicitly cleared. Configuration exports never contain secrets.

### The Remote Desktop exception

The built-in RDP client performs CredSSP (Network Level Authentication) inside the page, in WebAssembly, so it needs the password. When a session uses the saved credentials, the backend hands the password to the page **once per connection**, in the reply to the authenticated `rdp-open` request; it lives only in the client's connection settings while connecting and is never stored on the client. With "Ask for the password each time" (or "Connect as..."), the saved password never leaves the backend. The traffic itself goes through the backend's gateway, which opens TLS to the server.

### Connection targets

- A connection names a **saved server id**; the host, port, user, credentials and jump hosts always come from that database row. The client cannot point stored credentials at a host of its choosing, and ad-hoc local consoles from the client are refused.
- Changing the host, port or type of a saved server that keeps its stored secrets needs an explicit confirmation, so a credential is never silently sent to a new destination.
- A configuration import that names one of your saved identities, or asks for agent forwarding, is only linked to it after you consent (a separate confirmation the import file cannot give).
- The RDP gateway connects only to the saved Windows server of its ticket, whatever the client's RDCleanPath request names; its DER parser accepts only strict, size-limited DER.

### Host keys and certificates

- **SSH host keys** are trusted on first use and pinned per host, port and **jump route** (the same private address behind two bastions is two machines). A changed key stops the connection with `HOST_KEY_MISMATCH`, shows the expected and presented SHA-256 fingerprints, and only a user action trusts the new key. Pins are listed and removable in Known hosts.
- **RDP certificates** are pinned the same way on first connection (SHA-256 and SHA-1 thumbprints, subject, issuer, validity); a changed certificate is shown side by side with the pinned one before you may trust it, and that trust only accepts the exact certificate that was shown. TLS 1.2 is the minimum; standard RDP security without TLS is refused.
- Windows' default self-signed RDP certificate allows key encipherment but not digital signatures. In the desktop app the backend runs on Electron's Node, whose TLS library (BoringSSL) refuses such a certificate for TLS 1.3 and ECDHE key exchange. The gateway then connects again offering only TLS 1.2 with RSA key exchange, and logs that it did. That session has **no forward secrecy**: whoever later obtains the server's private key can decrypt a recording of it. The refused first handshake proves nothing (an attacker in the middle can cause it with a certificate of its own), so the gateway keeps the fallback only when the certificate it then receives does not allow digital signatures either and allows key encipherment; otherwise it refuses the connection as possibly intercepted (`RDP_TLS_FAILED`) and leaves the pin alone. An attacker in the middle therefore cannot take forward secrecy away from a server whose certificate allows digital signatures; a server whose certificate does not gets the fallback on every connection anyway, and that certificate is checked against its pin as usual. The audit entry of each RDP connection records its TLS version, cipher suite and whether it has forward secrecy (`tls` in `rdp connect`). A self-hosted backend (`npm run serve`, Node's OpenSSL) negotiates TLS 1.3 with the same certificate. To keep forward secrecy in the desktop app, give the server an RDP certificate whose key usage includes Digital Signature (for example one issued by your CA).
- Trust on first use cannot detect an attacker present at the very first connection. For sensitive servers, compare the fingerprint shown at the first connection with the server's (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).

### Commands, the audit log and secret masking

- Commands that ShellMind builds (status, operations, fleet checks, patching, disk cleanups, Kubernetes, diagnosis evidence) are assembled from validated names and quoted arguments: POSIX scripts are sent to `sh -s` and PowerShell scripts to `powershell -NoProfile -NonInteractive -Command -` on standard input, so the login shell only parses that fixed command (see [Antivirus and EDR](#antivirus-and-edr)); PowerShell arguments are single-quoted verbatim strings in printable ASCII, with every other character (typographic quotes included) spelled as a `[char]` code outside the quotes. Privileged actions use `sudo -n` only: ShellMind never stores or types a sudo password.
- The **audit log** records every command ShellMind runs or types: AI runs and Auto-Run steps, snippets, multi-exec jobs, operations actions, Kubernetes actions, patch runs and reboots, disk cleanups, broadcast lines, container and pod shells, identity key installs, fleet settings, and RDP sessions (start, end, certificate trust). It is kept 90 days by default (30, 180, 365 days or unlimited in Settings). Commands the interface types into a terminal (AI, snippets, multi-exec, operations, broadcast lines) are reported by it through `POST /api/audit` and marked "reported" in the log; that route refuses the sources only the backend writes (fleet, identity, RDP), so those entries cannot be forged through the API.
- **Secret masking**: snippet variables that are secret (`{{password}}`, `{{secret:...}}`, names that look sensitive, or marked with the lock) are replaced by their placeholder in the audit log, the job history and the terminal history, masked in multi-exec output, and masked in the terminal text the AI reads. A line typed at a password prompt is never stored in the history or the audit log, nor broadcast to other terminals.
- The backend's logger replaces secret-looking fields with `[redacted]` and masks bearer tokens. `SHELLMIND_DEBUG=1` logs SSH packets and the FTP control channel, which contain hosts, users and paths: never leave it on.
- Local consoles and CLIs that the backend spawns get an environment without ShellMind's settings and secrets (`SHELLMIND_*`, `GEMINI_*`, `MINIMAX_*`, `*_API_KEY`, `DB_PATH`), so `env` in a local terminal cannot reveal them.

### The AI assistant

**What is sent.** When you use the chat, the request contains your message, the conversation history of that server, recent terminal and command output, any evidence you attached (service status, logs, the status snapshot, container or pod details), and the server's name, OS and shell. Known secret formats (PEM private keys, JSON Web Tokens, AWS access key ids and common API tokens, `Authorization` headers, passwords in URLs, secret-looking `key=value` assignments, and credentials passed as command-line options such as `--password`, `mysql -p` or `curl -u`) are masked before sending. Masking works on formats: a password printed on its own line cannot be recognized. Saved credentials are never part of a request.

**Where it goes.**

- **MiniMax without your own key**: to the ShellMind proxy (`https://ai-proxy.luisbh.com` by default, `MINIMAX_PROXY_URL`), which forwards it to MiniMax with a managed key, as described in the [legal notice](https://shellmind.app/legal.html#ai-data).
- **MiniMax with your own key**: directly to MiniMax's API (`MINIMAX_API_BASE_URL`); your key is sent only there. If MiniMax rejects your key, the request is retried through the proxy, without your key.
- **Gemini**: directly to Google with your Gemini key.

The chat shows which route is used and what is sent before the first MiniMax request, and the evidence of a diagnosis is shown in full before you send it. Nothing is sent to an AI provider unless you send a chat message or press a button that does.

**Prompt injection.** Text captured from your systems (terminal output, command output, evidence) reaches the model inside delimited data blocks whose identifier is random per request, and the system prompt tells the model to treat it as data. Evidence for a diagnosis is collected by the backend with read-only commands and signed, so the client cannot pass its own text off as collected evidence. These measures reduce, but cannot eliminate, the risk that hostile text on a server steers the model; the gates below are the real protection.

**Running commands.**

- A command from the AI runs only when you press Run, or with Auto-Run enabled after a confirmation.
- Every command typed by the AI, Auto-Run, snippets, multi-exec or broadcast first goes through a **destructive-command gate** (`shared/commandSafety.ts`) that parses the line structurally (quotes, escapes, `sudo`/`env`/`xargs` wrappers, same-line variables, PowerShell `-EncodedCommand`) and asks for confirmation before wiping files or disks, powering a host off, dropping databases, piping downloads into a shell, opening backdoors and similar. It is a confirmation gate, not a sandbox: a determined script can hide what it does.
- **Auto-Run** types at most five steps before it pauses, only once the shell shows a prompt again (never into a running program, a full-screen program or a password prompt), always waits for your approval on a destructive command, never runs the fix proposed by a diagnosis, and turns off when you switch servers or close the chat.

## Antivirus and EDR

ShellMind automates shells, which security products watch closely. Two of its techniques could look like obfuscation to Microsoft Defender or an EDR, so it avoids the shape they flag.

**Scripts on Windows servers.** The status dashboard, operations panels, fleet health probe, patch scan, disk toolkit, identity key installs and AI evidence collection run fixed PowerShell scripts on Windows servers over SSH. The script travels on the **standard input** of one short, fixed command line:

```
powershell -NoProfile -NonInteractive -Command -
```

The command line is therefore always the same innocuous string, and the script itself is never on it. This matters: a long `-EncodedCommand <base64>` command line is exactly the shape endpoint protection associates with obfuscated PowerShell — Microsoft Defender's command-line heuristic (`!#SLF:CMD_HSTR:General.ML`) blocked such command lines on a Windows Server 2025 test machine. Delivering the script on stdin leaves the heuristic nothing to match. The scripts only read, except for the actions you start and confirm (service actions, disk cleanups, installing a public key), and their source is in this repository (`server/status/windows.ts`, `server/ops/`, `server/fleet/probe.ts`, `server/patch/`, `server/disk/`, `server/identities/install.ts`, `server/ai/diagnose/`). On Linux servers, scripts go to `sh -s` on standard input the same way.

`-EncodedCommand` (base64 UTF-16LE) remains a documented fallback for an SSH server that does not forward a command's stdin to the child process: set `SHELLMIND_POWERSHELL_DELIVERY=encoded` in the backend environment to use it everywhere. It runs the same whether the OpenSSH default shell is cmd.exe or PowerShell, but makes the long command line above. A script on stdin must be ASCII, since PowerShell decodes it with the console code page; ShellMind spells every other character in ASCII (`[char]` codes), so its own scripts never need the fallback.

**Multi-line PowerShell blocks in the terminal.** When the chat, a snippet or the history sends a block of several lines to a PowerShell terminal, ShellMind types it as one runner line that decodes the block (DEFLATE-compressed, base64) and runs it statement by statement in the current session:

```
try { $__sm = [scriptblock]::Create([IO.StreamReader]::new([IO.Compression.DeflateStream]::new(...FromBase64String('...')...
```

This keeps `cd` and variables working and avoids PowerShell's line-by-line pitfalls (see `shared/powershell.ts`). It is compressed on purpose: PSReadLine repaints the whole input line on every keystroke, so an uncompressed block costs roughly the square of its length — a 16 KB block sent as plain quoted strings makes the terminal print about 1.7 MB and take ~15 s, versus ~134 KB and ~4 s compressed. Single lines are typed as they are. You see the block in the chat before it runs, and it is recorded in the audit log. Because it uses `DeflateStream` and `FromBase64String`, PowerShell's Script Block Logging records it as event 4104 at the *Warning* level; that is verbose logging, not a detection, and Defender does not act on it.

**If your security product blocks or flags these:**

- Do not disable AMSI or real-time protection: AMSI scans the decoded script content either way, which is what you want.
- Use a dedicated account for ShellMind on your Windows servers, and scope any exclusion or alert suppression to that account and the parent process `sshd.exe`. In Microsoft Defender for Endpoint, use a suppression rule for the alert or an indicator scoped to that device group rather than a global exclusion.
- For the terminal runner, suppress the Script Block Logging (4104) warnings for PowerShell command lines starting with `try { $__sm = [scriptblock]::Create(` in the interactive sessions of your admin accounts, rather than disabling logging.
- On the machine that runs ShellMind, allow the ShellMind executable (and, for a self-hosted backend, `node`), whose child processes are the local consoles and CLIs you open.
- Check what was detected with `Get-MpThreatDetection` (Defender) and compare it with the audit log, which records every command ShellMind ran and when.

**Accounts that are not administrators.** Over an SSH logon, Windows lets only administrators use WMI, list the services, read the event logs and performance counters, or search Windows Update. ShellMind detects this and, for any other account, reads the same facts through paths that do not need those privileges (the registry, `DriveInfo`, `GlobalMemoryStatusEx`, the network interfaces' own counters, `Get-Service` by name). Where a fact genuinely needs an administrator the UI says so plainly, and an action the account may not perform is reported as refused, not as "not found". Save a Windows server with an administrator account for the full status, service management and Windows Update listing.

## Hardening checklist for self-hosting

- Keep `HOST=127.0.0.1` and publish ShellMind only through a TLS reverse proxy; list its name in `ALLOWED_HOSTS`.
- Set a long random `SHELLMIND_AUTH_TOKEN`, and rotate it if it may have leaked (every token holder controls every saved server).
- Run ShellMind as a dedicated, unprivileged OS user; remember that its local consoles run as that user.
- Keep the database and `shellmind.key` (or `SHELLMIND_DATA_KEY`) private to that user, and back them up together, encrypted.
- Prefer SSH keys and identities with the least privilege needed, and `sudo -n` rules limited to what you use ShellMind for.
- Leave `SHELLMIND_DEBUG` off and choose an audit retention that matches your policy.
- Keep ShellMind up to date.

## Known limitations

- One token, one user: no accounts, roles, MFA or per-server permissions.
- The destructive-command gate and secret masking are best-effort safety nets, not guarantees.
- Trust on first use cannot protect the very first connection to a server.
- The built-in RDP client receives the saved RDP password once per connection (see above).
- In the desktop app, Remote Desktop sessions to a server with Windows' default self-signed certificate use TLS 1.2 with RSA key exchange, without forward secrecy; the audit log marks them (`forwardSecrecy: false`). A certificate whose key usage includes Digital Signature avoids that, and an attacker in the middle cannot force the fallback on it (see Host keys and certificates).
- On Linux without a keyring, the desktop app's data key is protected only by file permissions.
- The installers are not code-signed yet (the Mac app is signed ad hoc, not notarized); download them only from the project's GitHub releases and compare them with the release's `SHA256SUMS.txt`, or check their build provenance with `gh attestation verify <package> --repo Luisbh-dev/shellmind`. The release workflow builds them with read-only repository access; only its publish step can attach files to a release.
