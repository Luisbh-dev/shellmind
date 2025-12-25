# 🐚 ShellMind

> **Version 0.1.5 SSH Key Authentication**

**Your AI-Powered System Administration Companion.**

🌐 **Official Website:** [https://shellmind.app/](https://shellmind.app/)

ShellMind is a robust, self-hosted server management dashboard that integrates **Generative AI** to help you manage, debug, and automate your infrastructure. It provides a unified interface for SSH (Linux), PowerShell (Windows), RDP, FTP, and SFTP access directly in your browser, with an agentic AI co-pilot that assists you in real-time.

## ✨ Key Features

### 🧠 Multi-Model AI Core (Updated in v0.1.3)
-   **Dynamic Model Switching**: Select your preferred intelligence level:
    -   **Flash 3 (Smartest)**: Powered by the experimental Gemini 3.0 Flash Preview models for cutting-edge reasoning.
    -   **Flash 2.5 (Smart)**: The balanced, reliable standard.
    -   **Gemma 3 (Standard)**: For tasks requiring a different model architecture.
-   **Persistent Preference**: Your selected model is now saved in the system settings and remembered across sessions.
-   **Smart Fallback**: Automatically switches models if rate limits are reached.
-   **Context-Aware**: The AI reads your terminal output. If a command fails, it analyzes the error and suggests fixes immediately.
-   **Auto-Run Agent**: Enable "Auto-Run" mode to let the AI execute commands, analyze the output, and self-correct until the task is done (requires user confirmation).
-   **Language Persistence**: The AI detects your language (e.g., Spanish) and maintains the conversation in that language.

### 🖥️ Multi-Protocol Connectivity
-   **Smart Terminal**: Full-featured web terminal with WebGL acceleration. Supports **SSH** with Password or **Private Key** authentication, and **PowerShell** (via OpenSSH) for Windows.
-   **Windows Support**: Complete Windows Server management including:
    -   **PowerShell**: Native terminal access wrapped for compatibility.
    -   **RDP**: Integrated Remote Desktop Protocol client in the browser (**Work in Progress**).
    -   **SFTP**: File management for Windows via OpenSSH.
-   **FTP Support (New in v0.1.2)**: Connect to legacy FTP servers to manage files with a modern UI.
-   **S3 Storage (New in v0.1.4)**: View and manage files in AWS S3 and confirm S3-compatible buckets (MinIO, R2, etc).
-   **SSH Keys (New in v0.1.5)**: Helper to add servers using PEM/OpenSSH private keys instead of passwords.
-   **SFTP Explorer**: Integrated file manager to browse, upload, download, and delete files (supports Linux, Windows, FTP, and S3).

### 📈 Real-Time Monitoring
-   **System Dashboard**: Dedicated 'Status' tab.
    -   **Linux**: Runs `htop` automatically.
    -   **Windows**: Displays a live dashboard with CPU, RAM, Disk Usage, and Top Processes using PowerShell.

### 🛡️ Privacy & Security
-   **Local Storage**: All server credentials are encrypted and stored in a local SQLite database.
-   **Self-Hosted**: You own your data. No external cloud dependency for connection management.

## 🚀 Getting Started

### Prerequisites
-   Node.js Runtime
-   A Generative AI API Key (See below)

### 🔑 How to get a Free Gemini API Key

ShellMind is powered by Google's Generative AI models, which offer a generous free tier perfect for personal use.

1.  Go to **[Google AI Studio](https://aistudio.google.com/app/apikey)**.
2.  Log in with your Google account.
3.  Click **"Create API key"**.
4.  **Done!** The free tier includes **250 requests per day**, which is more than enough for daily system administration tasks.

### Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/Luisbh-dev/shellmind.git
    cd shellmind
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    Create a `.env` file in the root directory:
    ```env
    GEMINI_API_KEY=your_api_key_here
    ```
    *Note: You can also configure the API Key via the UI Settings if not provided in the environment.*

4.  **Run the App**:
    Start the development server:
    ```bash
    npm start
    ```
    *(Or run `npm run dev` and `npm run server` separately if needed)*

5.  **Access**:
    Open `http://localhost:5173` in your browser.

## 💡 Why ShellMind?

ShellMind was born from the need to modernize the system administrator's toolkit. While CLI tools are powerful, switching between multiple terminal windows, RDP clients, and file transfer tools can be cumbersome. ShellMind brings everything into a single, unified interface powered by the web technology you already know.

By integrating an agentic AI, ShellMind transforms from a simple dashboard into a proactive partner that helps you solve problems faster, automates repetitive tasks, and acts as a second pair of eyes during critical operations.

## 🤝 Contributing

Contributions are welcome! Please fork the repository and submit a Pull Request.

## 📜 License

MIT License. Created by [Luisbh-dev](https://github.com/Luisbh-dev).
