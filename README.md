# ShellMind

> Version 0.2.0

ShellMind is a self-hosted remote workspace that combines terminal access, file management, remote desktop, and AI assistance in one focused interface.

It is designed for day-to-day server work across SSH, PowerShell, FTP, SFTP, and S3-compatible storage while keeping the workflow fast, local, and practical.

## What is new in 0.2.0

- MiniMax M2.7 support through the Anthropic-compatible API.
- Gemini and MiniMax API keys can now be configured independently.
- MiniMax M2.7 is now the default and recommended AI model.
- AI model selection UI has been refined with cleaner recommendation styling.
- The noisy floating SSH issue warning in chat was removed.
- Existing SSH issue analysis and quick-fix tools remain available in the chat panel.
- README and environment configuration were updated for multi-provider AI usage.

## Core features

### AI Assistant
- Chat with the active server in context.
- Use Gemini or MiniMax models from the same assistant.
- Send terminal code blocks to the shell with one click.
- Enable Auto-Run for trusted command execution.
- Use `Analyze` and `Fix it` when SSH failures are detected.

### Terminal
- SSH terminal for Linux and Unix-like servers.
- PowerShell and SSH support for Windows servers.
- Live status tab for system checks and diagnostics.
- Automatic detection of common SSH failures from terminal output.
- Highlighted error lines and clickable links directly in the terminal.
- Built-in terminal search and quick clear controls.

### File management
- Browse, upload, download, delete, rename, and create folders.
- SFTP and FTP support for remote file operations.
- S3 bucket browsing with folder marker support.
- Folder creation and rename actions via modal dialogs.
- AI assistant is disabled for S3 to keep the experience focused.

### Remote access
- Native RDP launch for Windows servers.
- Unified server switching from the sidebar.

## Getting started

### Requirements
- Node.js
- A Gemini or MiniMax API key

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
MINIMAX_API_KEY=your_minimax_key_here
MINIMAX_ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic/v1
```

You can also configure Gemini and MiniMax API keys from the app settings.

### Run

```bash
npm start
```

This starts the frontend and backend together.

## Desktop build note

For the public GitHub repository, do not commit provider API keys.

For private desktop builds, prefer injecting secrets at build or runtime instead of hardcoding them in the repository. If the app will be distributed broadly, the safest approach is to route AI traffic through your own backend or proxy and keep the provider key only on infrastructure you control.

## Release notes

### 0.2.0
- MiniMax M2.7 integrated through the Anthropic-compatible API.
- Gemini and MiniMax keys can be stored separately in settings.
- MiniMax M2.7 is now the default model.
- AI selector UI was cleaned up and recommendation styling was improved.
- Chat no longer shows the floating SSH issue warning banner.

### 0.1.9
- Terminal search and clickable URLs added to xterm.
- SSH error lines are now highlighted directly in the terminal.
- File explorer now supports modal-based create folder and rename flows.
- AI Hints and terminal controls were polished for a cleaner workflow.
- Auto-Run confirmation and SSH error analysis were refined.

### 0.1.8
- SSH issue detection and `Fix it` workflow introduced.

## License

MIT License. Created by [Luisbh-dev](https://github.com/Luisbh-dev).
