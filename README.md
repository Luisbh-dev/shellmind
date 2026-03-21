# ShellMind

> **Version 1.7.0**

ShellMind is a self-hosted server management dashboard with AI assistance for SSH, PowerShell, FTP, SFTP, and remote administration workflows.

Official website: https://shellmind.app/

## Features

- Smart terminal for SSH and Windows PowerShell
- Native Remote Desktop launch for Windows servers
- Embedded RDP view is disabled in v1.7.0 while the renderer is being stabilized
- FTP and SFTP file management
- S3 storage browser
- Multi-model AI assistant
- Local SQLite storage for server credentials and settings

## Getting Started

### Prerequisites

- Node.js
- A Gemini API key

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

### Run in development

```bash
npm start
```

Then open:

```text
http://localhost:5173
```

## Notes

- The embedded RDP button is intentionally disabled in v1.7.0.
- Use the native Remote Desktop launcher for Windows connections.
- All credentials are stored locally in SQLite.

## License

MIT. Created by Luisbh-dev.
