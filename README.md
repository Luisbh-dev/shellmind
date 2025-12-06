# 🐚 ShellMind

> **Version 0.1.0 Alpha**

**Your AI-Powered System Administration Companion.**

🌐 **Official Website:** [https://shellmind.app/](https://shellmind.app/)

ShellMind is a robust, self-hosted server management dashboard that integrates **Generative AI** to help you manage, debug, and automate your infrastructure. It provides a unified interface for SSH (Linux), PowerShell (Windows), RDP, and SFTP access directly in your browser, with an agentic AI co-pilot that assists you in real-time.

## ✨ Key Features

### 🖥️ Multi-Protocol Connectivity
-   **Smart Terminal**: Full-featured web terminal with WebGL acceleration. Supports **SSH** for Linux and **PowerShell** (via OpenSSH) for Windows.
-   **Windows Support**: Complete Windows Server management including:
    -   **PowerShell**: Native terminal access wrapped for compatibility.
    -   **RDP**: Integrated Remote Desktop Protocol client in the browser (**Work in Progress**).
    -   **SFTP**: File management for Windows via OpenSSH.
-   **SFTP Explorer**: Integrated file manager to browse, upload, download, and delete files (supports both Linux & Windows).

### 🧠 Agentic IA SysAdmin
-   **Context-Aware**: The AI reads your terminal output. If a command fails, it analyzes the error and suggests fixes immediately.
-   **Auto-Run Agent**: Enable "Auto-Run" mode to let the AI execute commands, analyze the output, and self-correct until the task is done (requires user confirmation).
-   **Language Persistence**: The AI detects your language (e.g., Spanish) and maintains the conversation in that language, even when analyzing technical English outputs.

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

ShellMind is powered by Google's Gemini 2.5 Flash model, which offers a generous free tier perfect for personal use.

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
    GEMINI_MODEL_NAME=gemini-2.5-flash
    ```
    *Note: You can also configure the API Key via the UI Settings if not provided in the environment.*

4.  **Run the App**:
    Start the development server:
    ```bash
    npm run dev
    npm run server
    ```

5.  **Access**:
    Open `http://localhost:5173` in your browser.

## 💡 Why ShellMind?

ShellMind was born from the need to modernize the system administrator's toolkit. While CLI tools are powerful, switching between multiple terminal windows, RDP clients, and file transfer tools can be cumbersome. ShellMind brings everything into a single, unified interface powered by the web technology you already know.

By integrating an agentic AI, ShellMind transforms from a simple dashboard into a proactive partner that helps you solve problems faster, automates repetitive tasks, and acts as a second pair of eyes during critical operations.

## 🤝 Contributing

Contributions are welcome! Please fork the repository and submit a Pull Request.

## 📜 License

MIT License. Created by [Luisbh-dev](https://github.com/Luisbh-dev).
