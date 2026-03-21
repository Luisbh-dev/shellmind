# ShellMind

> Version 0.1.9

ShellMind is a self-hosted remote workspace that combines terminal access, file management, remote desktop, and AI assistance in one focused interface.

It is designed for day-to-day server work across SSH, PowerShell, FTP, SFTP, and S3-compatible storage while keeping the workflow fast, local, and practical.

## What is new in 0.1.9

- Cleaner overall UX across the terminal, file explorer, and assistant.
- Protocol-aware folder creation and rename flows from the file browser.
- Improved automatic SSH error detection from terminal output.
- SSH errors now appear highlighted directly inside the terminal.
- Clickable URLs in terminal output.
- Terminal search with `Ctrl+F`.
- Screen clear button in the terminal toolbar.
- Contextual AI Hints for common shell and troubleshooting tasks.
- Safer Auto-Run confirmation inside the chat.
- S3 keeps the assistant disabled to stay focused on file browsing.

## Core features

### AI Assistant
- Chat with the active server in context.
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

You can also configure the API key from the app settings.

### Run

```bash
npm start
```

This starts the frontend and backend together.

## Release notes

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
