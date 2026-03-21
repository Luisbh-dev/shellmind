# ShellMind

> **Version 0.1.9**

ShellMind is a self-hosted server workspace that brings terminal access, file management, remote desktop, and AI assistance into one interface.

It is built for fast day-to-day operations across SSH, PowerShell, FTP, SFTP, and S3-compatible storage, while keeping the workflow local and focused.

## What is new in 0.1.9

- Better UX across the file explorer and AI assistant flows.
- Create folders from a modal, with protocol-aware handling for SSH, FTP, and S3.
- Rename files and folders directly from the file browser.
- Improved automatic SSH error detection from terminal output.
- Cleaner AI-assisted troubleshooting with `Analyze` and `Fix it`.
- Safer Auto-Run confirmation in the chat.

## Core features

### AI Assistant
- Chat with the active server in context.
- Send terminal code blocks to the shell with one click.
- Enable Auto-Run for trusted command execution.
- Use `Analyze` and `Fix it` when SSH failures are detected.

### Terminal and monitoring
- SSH terminal for Linux and Unix-like servers.
- PowerShell and SSH support for Windows servers.
- Live status tab for system checks and diagnostics.
- Terminal output is scanned for common failure patterns and surfaced in the assistant.

### File management
- Browse, upload, download, delete, rename, and create folders.
- SFTP and FTP support for remote file operations.
- S3 bucket browsing with folder marker support.
- AI assistant is disabled for S3 to keep the experience focused.

### Remote access
- Native RDP launch for Windows servers.
- Unified connection switching from the sidebar.

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
- UI/UX polish across the assistant and file explorer.
- Folder creation and rename flows added to the file browser.
- Automatic SSH error detection improved and surfaced in the assistant.

### 0.1.8
- SSH issue detection and `Fix it` workflow introduced.

## License

MIT License. Created by [Luisbh-dev](https://github.com/Luisbh-dev).
