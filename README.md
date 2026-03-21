# ShellMind

> **Version 0.1.8**

**Your AI-powered system administration companion.**

ShellMind is a self-hosted server management dashboard that combines SSH, PowerShell, FTP, SFTP, S3, RDP, and AI assistance in one place. It helps you inspect systems, run commands, and troubleshoot failures faster from a single interface.

## Key Features

### AI Terminal Diagnostics
- Detects SSH terminal failures from live terminal output and backend error events.
- Surfaces the latest issue in the chat with a small alert banner.
- Includes `Analyze` to prompt the AI with the last failure context.
- Includes `Fix it` to request the exact command needed to resolve the issue.
- Reuses recent terminal history so the AI gets the full context, not just one line.

### AI Assistant
- Chat with the assistant about the active server and recent terminal activity.
- Supports code block rendering with one-click `Run`.
- `Auto-Run` can execute generated commands and feed the output back for follow-up analysis.
- Model selection is available from the assistant header.

### Multi-Protocol Connectivity
- SSH terminal for Linux and Unix-like servers.
- PowerShell / OpenSSH terminal support for Windows servers.
- FTP support for legacy servers.
- SFTP file explorer for browsing, uploading, downloading, and deleting files.
- S3 bucket browsing for S3-compatible storage.
- Native RDP launch for Windows servers.

### Real-Time Monitoring
- Dedicated `Status` tab for live system checks.
- Linux status uses `htop` when available.
- Windows status shows CPU, memory, disk, uptime, and top processes.

### Privacy and Security
- Credentials are stored locally in SQLite.
- The app is self-hosted and does not depend on a remote control plane for server access.

## Getting Started

### Prerequisites
- Node.js
- An AI API key

### Install

```bash
git clone https://github.com/Luisbh-dev/shellmind.git
cd shellmind
npm install
```

### Configure

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_api_key_here
```

You can also configure the API key from the app settings if you prefer.

### Run

```bash
npm start
```

This starts the web UI and the backend server together.

## What Changed in 0.1.8

This release follows `0.1.7`.

Previous release note: `0.1.7` was the last stable baseline before the SSH diagnostics and Fix it workflow were added.

- Added SSH failure detection from terminal and backend error streams.
- Added the `Last SSH issue` panel in the chat.
- Added `Analyze` and `Fix it` workflows for faster troubleshooting.
- Added issue toast notifications when a new terminal failure is detected.
- Improved terminal context passed to the AI assistant.

## Contributing

Contributions are welcome. Please fork the repository and open a pull request.

## License

MIT License. Created by [Luisbh-dev](https://github.com/Luisbh-dev).
