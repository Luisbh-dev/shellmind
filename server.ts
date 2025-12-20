import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Client } from "ssh2";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import cors from "cors";
import dotenv from "dotenv";
import db from "./database";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow Vite dev server
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'] // Allow both but prefer websocket
});

app.use(cors());
app.use(express.json());

const PORT = 3001; // Backend port
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- API Routes ---

// Get all servers
app.get("/api/servers", (req, res) => {
    db.all("SELECT * FROM servers", [], (err, rows) => {
        if (err) {
            res.status(400).json({ "error": err.message });
            return;
        }
        res.json({
            "message": "success",
            "data": rows
        });
    });
});

// Add a new server
app.post("/api/servers", (req, res) => {
    console.log("POST /api/servers received body:", req.body);
    try {
        const { name, ip, type, username, password, port, ssh_port } = req.body;
        const sql = "INSERT INTO servers (name, ip, type, username, password, port, ssh_port) VALUES (?,?,?,?,?,?,?)";
        // For Linux: port is SSH. For Windows: port is RDP, ssh_port is SSH.
        const params = [
            name,
            ip,
            type,
            username,
            password,
            port || (type === 'windows' ? 3389 : 22),
            ssh_port || 22
        ];

        console.log("Executing SQL:", sql, "Params:", params);

        db.run(sql, params, function (err) {
            if (err) {
                console.error("Database Insert Error:", err.message);
                res.status(500).json({ "error": err.message });
                return;
            }
            console.log("Server added with ID:", this.lastID);
            res.json({
                "message": "success",
                "data": { id: this.lastID, ...req.body }
            });
        });
    } catch (e: any) {
        console.error("Exception in POST /api/servers:", e);
        res.status(500).json({ "error": e.message });
    }
});

// Update an existing server
app.put("/api/servers/:id", (req, res) => {
    console.log("PUT /api/servers/" + req.params.id, req.body);
    const { name, ip, type, username, password, port, os_detail, ssh_port } = req.body;
    const sql = "UPDATE servers SET name = ?, ip = ?, type = ?, username = ?, password = ?, port = ?, os_detail = ?, ssh_port = ? WHERE id = ?";
    const params = [
        name,
        ip,
        type,
        username,
        password,
        port || (type === 'windows' ? 3389 : 22),
        os_detail,
        ssh_port || 22,
        req.params.id
    ];

    db.run(sql, params, function (err) {
        if (err) {
            console.error("Database Update Error:", err.message);
            res.status(500).json({ "error": err.message });
            return;
        }
        res.json({
            "message": "success",
            "changes": this.changes
        });
    });
});

// Patch OS detail
app.patch("/api/servers/:id/os", (req, res) => {
    const { os_detail } = req.body;
    db.run("UPDATE servers SET os_detail = ? WHERE id = ?", [os_detail, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "success" });
    });
});

// Delete a server
app.delete("/api/servers/:id", (req, res) => {
    db.run("DELETE FROM servers WHERE id = ?", req.params.id, function (err) {
        if (err) {
            res.status(400).json({ "error": err.message });
            return;
        }
        res.json({ "message": "deleted", changes: this.changes });
    });
});


// --- Configuration Routes ---

// Check if API Key is configured
app.get("/api/config/status", (req, res) => {
    if (process.env.GEMINI_API_KEY) {
        return res.json({ configured: true, source: "env" });
    }
    db.get("SELECT value FROM settings WHERE key = 'GEMINI_API_KEY'", [], (err, row: any) => {
        if (row && row.value) {
            res.json({ configured: true, source: "db" });
        } else {
            res.json({ configured: false, source: "none" });
        }
    });
});

// Set API Key (only if not in env)
app.post("/api/config/apikey", (req, res) => {
    if (process.env.GEMINI_API_KEY) {
        return res.status(403).json({ error: "API Key is already set via Environment Variables." });
    }
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Key is required" });

    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('GEMINI_API_KEY', ?)", [key], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "success" });
    });
});

// Get Preferred Model
app.get("/api/config/model", (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'PREFERRED_MODEL'", [], (err, row: any) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ model: row ? row.value : "gemini-2.5-flash" });
    });
});

// Set Preferred Model
app.post("/api/config/model", (req, res) => {
    const { model } = req.body;
    if (!model) return res.status(400).json({ error: "Model is required" });
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('PREFERRED_MODEL', ?)", [model], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "success" });
    });
});

// Chat API Route
app.post("/api/chat", async (req: any, res: any) => {
    try {
        const { message, context, model: requestedModel } = req.body;

        let apiKey = process.env.GEMINI_API_KEY;

        // If not in env, check DB
        if (!apiKey) {
            const row: any = await new Promise((resolve, reject) => {
                db.get("SELECT value FROM settings WHERE key = 'GEMINI_API_KEY'", [], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (row && row.value) {
                apiKey = row.value;
            }
        }

        if (!apiKey) {
            return res.json({ response: "Please set your GEMINI_API_KEY in Settings or Environment variables." });
        }

        // Determine Model
        let targetModel = requestedModel;
        if (!targetModel) {
            // Check DB if not provided in request
            const row: any = await new Promise((resolve) => {
                db.get("SELECT value FROM settings WHERE key = 'PREFERRED_MODEL'", [], (err, row) => resolve(row));
            });
            // Default to Flash if nothing configured 
            targetModel = (row && row.value) ? row.value : "gemini-2.5-flash";
        }

        console.log(`[Chat] Using Gemini Model: ${targetModel}`);

        const genAI = new GoogleGenerativeAI(apiKey);

        const SYSTEM_PROMPT = `You are ShellMind AI, an expert Linux/Windows System Administrator assistant. 
    Your goal is to help manage servers, write scripts, debug errors, and explain commands.
    
    CRITICAL BEHAVIORAL RULES:
    1. **LANGUAGE DETECTION & PERSISTENCE**:
       - Detect the user's language from the query (e.g., Spanish, English, French).
       - **ALWAYS respond in the SAME language as the user's query.**
       - If the user speaks Spanish, answer in Spanish.
       - **SPECIAL RULE**: If the user query starts with "[AUTOMATED SYSTEM OUTPUT]", this is a technical system report. DO NOT switch to English. **You must analyze this technical output but respond to the user in their ORIGINAL language** (the one used in previous messages).
    
    2. **NON-INTERACTIVE MODE**: Always assume commands are run in a script/automation context.
       - Use \`-y\` for apt/yum/dnf.
       - Use \`DEBIAN_FRONTEND=noninteractive\` for complex installs.
       - NEVER suggest opening interactive editors like \`nano\`, \`vim\`, or \`less\`.
       - To edit files, use \`sed\`, \`echo\`, \`printf\`, or \`cat\`.
    
    3. **ERROR ANALYSIS**:
       - You will receive the "[LAST 50 LINES OF TERMINAL OUTPUT]" in the context.
       - **WARNING**: This is a PARTIAL snapshot. The command might still be running.
       - **DO NOT** assume error just because the output stops abruptly or looks incomplete.
       - **ONLY** report errors if you see explicit error messages (e.g., "command not found", "failed", "error:").
       - If the output looks like a normal progress bar or partial log, assume it is working.
       - ANALYZE this output first. If there is an explicit error, fix THAT specific error.
       - Do not repeat commands that just failed without changing something.
    
    4. **WINDOWS SHELL COMPATIBILITY (CRITICAL)**:
       - **THE ENVIRONMENT IS RAW CMD.EXE**.
       - **AVOID POWERSHELL for simple file operations** (it is too verbose).
       - **FOR SIMPLE TASKS (cd, dir, mkdir, del, echo)**: YOU MUST USE STANDARD DOS COMMANDS.
         - Correct: \`mkdir "C:\\prueba"\`
         - Correct: \`echo hello > "C:\\file.txt"\`
         - Incorrect: \`New-Item ...\`
       - **FOR POWERSHELL TASKS (Services, Registry)**: You MUST type \`powershell\` explicitly.
         - Correct: \`powershell -Command "Get-Service"\`
         - Incorrect: \`-Command "Get-Service"\`
    
    5. **ROBUSTNESS**:
       - Chain commands with \`&&\` where appropriate, but keep blocks logical.
       - Check if processes exist before killing them (\`pgrep\`, \`pidof\`).
       - Verify success (e.g., \`docker ps\` after running a container).
    
    6. **APPLICATION DEPLOYMENT (CRITICAL)**:
       - **PREFER DOCKER** for modern web applications (Portainer, Nginx Proxy Manager, Databases) if Docker is present.
       - **DO NOT** invent \`apt\` packages for software that is typically distributed via Docker.
       - **EXAMPLE**: Portainer is installed via \`docker run\`, NOT \`apt install portainer\`.
       - **EXAMPLE**: If Docker is installed, use it to run containers instead of polluting the host OS.
    
    - Keep answers concise and technical.
    - **BE DIRECT**: Stop explaining obvious things like "The command executed successfully".
    - **OUTPUT ANALYSIS**: If a tool is already installed, just say "Docker is already installed." and move on.
    - Avoid phrases like "The output indicates that...", "It appears that...". Be assertive.
    - Assume the user is a professional admin.
    - Use markdown for code blocks.
    - Be aware of the current server context provided below.
    
    STRICT FORMATTING RULES:
    1. Do NOT put comments or explanations inside the code blocks.
    2. Put descriptions OUTSIDE the code blocks.
    3. Example of CORRECT output:
       To update the system:
       \`\`\`bash
       sudo apt update && sudo apt upgrade -y
       \`\`\`
    `;

        const fullPrompt = `${SYSTEM_PROMPT}\n\n[System Context: ${context || 'None'}]\n\nUser Query: ${message}`;

        const tryGenerate = async (modelName: string) => {
            console.log(`[Chat] Attempting with model: ${modelName}`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                ]
            });
            const result = await model.generateContent(fullPrompt);
            return await result.response;
        };

        let response;
        let usedModel = targetModel;

        try {
            response = await tryGenerate(targetModel);
        } catch (err: any) {
            console.error(`[Chat] Error with ${targetModel}:`, err.message);

            // Check for retryable errors (Quota, Overloaded, Timeout)
            const isRetryable = err.message.includes("429") || err.message.includes("503") || err.message.includes("quota");

            if (isRetryable) {
                // Swap model
                const fallbackModel = targetModel.includes("gemma") ? "gemini-2.5-flash" : "gemma-3-27b-it";
                console.log(`[Chat] ⚠️ Quota/Error limit reached. Auto-switching to fallback: ${fallbackModel}`);
                usedModel = fallbackModel;
                try {
                    response = await tryGenerate(fallbackModel);
                } catch (fallbackErr: any) {
                    throw new Error(`All models failed. Primary: ${err.message}. Fallback: ${fallbackErr.message}`);
                }
            } else {
                throw err;
            }
        }

        let text = response.text();

        // --- HOTFIX: Gemma 3 Auto-Correction ---
        // The model persistently starts commands with '-Command' despite instructions.
        // We enforce the correction here before sending to frontend.

        // Fix 1: Replace "-Command" at start of lines with "powershell -Command"
        text = text.replace(/^-Command\s+/gm, 'powershell -Command ');

        // Fix 2: If it generates "powershell -Command" inside a bash block, allow it, 
        // but if it generates raw cmdlets without wrapper, we might miss them, 
        // but the -Command pattern is the most frequent error.

        res.json({ response: text, usedModel: usedModel });
    } catch (error: any) {
        console.error("Error calling Gemini API:", error);
        res.status(500).json({ response: "Error processing your request: " + error.message });
    }
});

// Helper to normalize FTP paths (especially for Windows servers)
function normalizeFtpPath(path: string): string {
    let ftpPath = path;

    // Remove all quotes (defensive against malformed inputs from AI or frontend)
    ftpPath = ftpPath.replace(/"/g, '');

    // Convert backslashes to forward slashes (FTP standard)
    ftpPath = ftpPath.replace(/\\/g, '/');

    // Handle "/C:/" pattern -> "C:/" (Absolute Windows paths via standard client)
    if (/^\/[a-zA-Z]:/.test(ftpPath)) {
        ftpPath = ftpPath.substring(1);
    }

    return ftpPath;
}

// Socket.io Handling
io.on("connection", (socket) => {
    console.log("Client connected", socket.id);

    let sshStream: any = null;
    let sftp: any = null; // SSH2 SFTP Wrapper
    let ftp: any = null;  // Basic-FTP Client
    let connectionType: 'ssh' | 'ftp' = 'ssh';
    let ftpInProgress = false;

    let conn: Client | null = null;
    let termRows = 24;
    let termCols = 80;
    let connectionError: string | null = null;

    // --- SSH / FTP Connection Handling ---
    socket.on("start-ssh", async (config) => {
        connectionError = null;
        console.log("Start Connection Config received:", {
            host: config.host,
            user: config.username,
            type: config.type,
            port: config.port
        });

        const host = config.host?.replace(/[\s\u00A0]+/g, '').trim();
        const username = config.username?.trim() || "root";
        const isWindows = config.type === 'windows';
        const port = config.port || (config.type === 'ftp' ? 21 : 22);

        // Clean up previous connections
        if (conn) { conn.end(); conn = null; }
        if (ftp && !ftp.closed) { ftp.close(); ftp = null; }
        sftp = null;

        if (config.type === 'ftp') {
            console.log("Switched connectionType to FTP");
            connectionType = 'ftp';
            const { Client: FtpClient } = require("basic-ftp");
            ftp = new FtpClient();
            ftp.ftp.verbose = true;

            try {
                console.log(`Attempting FTP connection to ${host}:${port}`);
                await ftp.access({
                    host: host,
                    user: username,
                    password: config.password,
                    port: port,
                    secure: false
                });

                console.log("FTP Connected successfully");
                socket.emit("ssh-output", "\r\nConnected to FTP Server " + host + "\r\n");
                socket.emit("ftp-ready");
                socket.emit("connection-ready");

            } catch (err: any) {
                console.error("FTP Connection Error:", err);
                connectionError = err.message;
                socket.emit("ssh-error", "FTP Error: " + err.message);
            }
            return;
        }

        console.log("Proceeding with SSH connection (type was not ftp, was: " + config.type + ")");
        connectionType = 'ssh';
        conn = new Client();

        conn.on("ready", () => {
            socket.emit("ssh-output", "\r\nConnected to " + host + ":" + port + "\r\n");

            // Initialize SFTP
            conn!.sftp((err, sftpWrapper) => {
                if (err) {
                    console.error("SFTP Init Error:", err);
                } else {
                    sftp = sftpWrapper;
                    console.log("SFTP Session ready");
                    // Only emit ready when SFTP is actually ready to avoid race condition
                    socket.emit("connection-ready");
                }
            });

            // Detect OS immediately
            const osCheckCmd = isWindows
                ? "ver"
                : "grep PRETTY_NAME /etc/os-release || uname -sr";

            conn!.exec(osCheckCmd, (err, stream) => {
                if (err) return;
                let osData = "";
                stream.on("data", (d: any) => osData += d);
                stream.on("close", () => {
                    const osName = osData.replace(/PRETTY_NAME=|"/g, '').trim();
                    socket.emit("os-detected", osName);
                });
            });

            // Use standard xterm type for colors
            conn!.shell({ rows: termRows, cols: termCols, term: 'xterm-256color' }, (err, stream) => {
                if (err) {
                    socket.emit("ssh-error", err.message);
                    return;
                }

                sshStream = stream;

                socket.emit("ssh-output", "\r\nWelcome to ShellMind SSH Client\r\n");

                stream.on("close", () => {
                    conn!.end();
                    socket.emit("ssh-output", "\r\nConnection closed.\r\n");
                }).on("data", (data: any) => {
                    socket.emit("ssh-output", data.toString());
                });
            });
        }).on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
            console.log("SSH Keyboard-Interactive Prompt:", prompts);
            // Auto-respond to keyboard-interactive prompts (usually password)
            finish(prompts.map(() => config.password));
        }).on("error", (err: any) => {
            console.error("SSH Connection Error Full:", err);
            let msg = err.message;
            if (err.level === 'client-authentication') {
                msg = `Auth failed. Server accepts: ${err.methods}`;
            }
            connectionError = msg;
            socket.emit("ssh-error", msg);
        });

        try {
            // Clean minimal config first
            conn.connect({
                host: host,
                port: port,
                username: username,
                password: config.password,
                tryKeyboard: false, // Force password auth first since server supports it
                hostVerifier: () => true, // Accept any host key explicitly
                readyTimeout: 20000,
                debug: (str) => console.log("[SSH Debug]", str)
            });
        } catch (e: any) {
            console.error("SSH Connect Exception:", e);
            connectionError = "Unable to connect due to: " + e.message;
            socket.emit("ssh-error", connectionError);
        }
    });

    // --- File Operations Listeners (SFTP & FTP) ---
    socket.on("sftp-list", async (path) => {
        console.log(`[sftp-list] Request for ${path}. connectionType: ${connectionType}`);
        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not connected");

            if (ftpInProgress) {
                console.log("FTP operation in progress, skipping duplicate list request");
                return;
            }

            try {
                ftpInProgress = true;
                const list = await ftp.list(normalizeFtpPath(path));
                ftpInProgress = false;

                const files = list.map((item: any) => ({
                    name: item.name,
                    isDir: item.type === 2, // basic-ftp: 1=file, 2=dir
                    size: item.size,
                    mtime: item.rawModifiedAt ? new Date(item.rawModifiedAt).getTime() / 1000 : 0,
                    permissions: 0 // Not easily available in same format, ignore for now
                }));

                // Add ".." if not root and not in list (often FTP servers don't include it in listing if at root)
                // Actually frontend handles navigation, we just send file list.

                // Sort
                files.sort((a: any, b: any) => {
                    if (a.isDir === b.isDir) return a.name.localeCompare(b.name);
                    return a.isDir ? -1 : 1;
                });
                socket.emit("sftp-files", { path, files });
            } catch (err: any) {
                ftpInProgress = false;
                console.error("FTP List Error:", err.message);
                socket.emit("sftp-error", "FTP List Error: " + err.message);
            }
            return;
        }

        // SFTP Logic
        if (!sftp) {
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }
        sftp.readdir(path, (err: any, list: any[]) => {
            if (err) return socket.emit("sftp-error", "List error: " + err.message);
            const files = list.map((item: any) => ({
                name: item.filename,
                isDir: item.attrs.isDirectory(),
                size: item.attrs.size,
                mtime: item.attrs.mtime,
                permissions: item.attrs.mode
            }));
            // Sort: Directories first, then alphabetical
            files.sort((a: any, b: any) => {
                if (a.isDir === b.isDir) return a.name.localeCompare(b.name);
                return a.isDir ? -1 : 1;
            });
            socket.emit("sftp-files", { path, files });
        });
    });

    socket.on("sftp-read", async (path) => {
        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not initialized");
            const { Writable } = require('stream');
            const chunks: any[] = [];
            const writable = new Writable({
                write(chunk: any, encoding: any, callback: any) {
                    chunks.push(chunk);
                    callback();
                }
            });
            try {
                await ftp.downloadTo(writable, normalizeFtpPath(path));
                const buffer = Buffer.concat(chunks);
                socket.emit("sftp-file-content", { path, data: buffer.toString('base64') });
            } catch (err: any) {
                socket.emit("sftp-error", "FTP Read Error: " + err.message);
            }
            return;
        }

        if (!sftp) return socket.emit("sftp-error", "SFTP not initialized");
        // Limit size for safety? For now, simple read.
        // Using fastRead stream or readFile
        sftp.readFile(path, (err: any, buffer: Buffer) => {
            if (err) return socket.emit("sftp-error", "Read error: " + err.message);
            // Send as base64 to avoid binary encoding issues in socket.io json default
            socket.emit("sftp-file-content", { path, data: buffer.toString('base64') });
        });
    });

    socket.on("sftp-write", async ({ path, data }) => { // data is base64
        const buffer = Buffer.from(data, 'base64');

        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not initialized");
            const { Readable } = require('stream');
            const source = new Readable();
            source.push(buffer);
            source.push(null);

            try {
                await ftp.uploadFrom(source, normalizeFtpPath(path));
                socket.emit("sftp-write-success", path);
            } catch (err: any) {
                socket.emit("sftp-error", "FTP Write Error: " + err.message);
            }
            return;
        }

        if (!sftp) {
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }

        sftp.writeFile(path, buffer, (err: any) => {
            if (err) return socket.emit("sftp-error", "Write error: " + err.message);
            socket.emit("sftp-write-success", path);
        });
    });

    socket.on("sftp-delete", async ({ path, isDir }) => {
        console.log(`[Delete] Request for ${path} (isDir: ${isDir}) via ${connectionType}`);

        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not initialized");

            // Normalize path for FTP using helper
            const ftpPath = normalizeFtpPath(path);

            console.log(`[FTP Delete] Normalized path: '${ftpPath}' (Original: '${path}')`);

            try {
                if (isDir) {
                    await ftp.removeDir(ftpPath);
                } else {
                    await ftp.remove(ftpPath);
                }
                socket.emit("sftp-delete-success", path);
            } catch (err: any) {
                socket.emit("sftp-error", "FTP Delete Error: " + err.message);
            }
            return;
        }

        if (!sftp) {
            console.error("[SFTP] Error: SFTP not initialized during delete request");
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }

        if (isDir) {
            sftp.rmdir(path, (err: any) => {
                if (err) {
                    console.error("[SFTP] Rmdir Error:", err);
                    return socket.emit("sftp-error", "Delete directory error: " + err.message);
                }
                console.log("[SFTP] Directory deleted:", path);
                socket.emit("sftp-delete-success", path);
            });
        } else {
            sftp.unlink(path, (err: any) => {
                if (err) {
                    console.error("[SFTP] Unlink Error:", err);
                    return socket.emit("sftp-error", "Delete file error: " + err.message);
                }
                console.log("[SFTP] File deleted:", path);
                socket.emit("sftp-delete-success", path);
            });
        }
    });

    // Virtual Shell Buffer for FTP
    let ftpCommandBuffer = "";
    let currentFtpPath = "/";

    socket.on("ssh-input", async (data: string) => {
        if (connectionType === 'ftp') {
            // Echo back to terminal (pasting or typing)
            socket.emit("ssh-output", data);

            // Handle backspace (simple implementation)
            if (data === '\u007F') {
                if (ftpCommandBuffer.length > 0) {
                    ftpCommandBuffer = ftpCommandBuffer.slice(0, -1);
                    // Send backspace sequence to terminal to visually delete char
                    socket.emit("ssh-output", "\b \b");
                }
                return;
            }

            // Buffer processing
            // Accumulate buffer first
            // Replace \r with \n for consistency
            ftpCommandBuffer += data.replace(/\r/g, '\n');

            // Process lines if newline exists
            if (ftpCommandBuffer.includes('\n')) {
                const lines = ftpCommandBuffer.split('\n');
                // The last element is potentially an incomplete line, keep it in buffer
                const remaining = lines.pop() || "";

                // Process only complete lines
                for (let line of lines) {
                    const commandLine = line.trim();

                    socket.emit("ssh-output", "\r\n"); // Visual output for newline

                    if (!commandLine) {
                        socket.emit("ssh-output", "ftp> ");
                        continue;
                    }

                    const args = commandLine.split(" ");
                    const cmd = args[0].toLowerCase();
                    const arg1 = args[1];

                    try {
                        if (!ftp || ftp.closed) throw new Error("FTP connection lost");

                        if (cmd === 'ls' || cmd === 'dir' || cmd === 'll') {
                            const list = await ftp.list(normalizeFtpPath(currentFtpPath)); // Normalize
                            const output = list.map((f: any) => {
                                const date = new Date(f.modifiedAt || Date.now()).toISOString().split('T')[0];
                                const type = f.isDirectory ? 'd' : '-';
                                return `${type}rw-r--r-- 1 ftp ftp ${f.size.toString().padEnd(10)} ${date} ${f.name}`;
                            }).join('\r\n');
                            socket.emit("ssh-output", output + "\r\n");
                        }
                        else if (cmd === 'cd') {
                            const target = arg1 || "/";
                            if (target === "..") {
                                const parts = currentFtpPath.split('/').filter(p => p);
                                parts.pop();
                                currentFtpPath = "/" + parts.join('/');
                            } else if (target.startsWith('/')) {
                                currentFtpPath = target;
                            } else {
                                currentFtpPath = (currentFtpPath === '/' ? '' : currentFtpPath) + "/" + target;
                            }
                            // Normalize current path state
                            currentFtpPath = normalizeFtpPath(currentFtpPath);
                            // If root became empty/missing due to normalization, explicit /
                            if (!currentFtpPath) currentFtpPath = "/";

                            await ftp.cd(currentFtpPath);
                            socket.emit("ssh-output", `Changed directory to ${currentFtpPath}\r\n`);
                        }
                        else if (cmd === 'pwd') {
                            socket.emit("ssh-output", currentFtpPath + "\r\n");
                        }
                        else if (cmd === 'mkdir') {
                            if (!arg1) throw new Error("Usage: mkdir <path>");
                            const fullPath = (currentFtpPath === '/' ? '' : currentFtpPath) + "/" + arg1;
                            await ftp.ensureDir(normalizeFtpPath(fullPath));
                            socket.emit("ssh-output", `Created directory ${arg1}\r\n`);
                        }
                        else if (cmd === 'rm') {
                            if (!arg1) throw new Error("Usage: rm <path>");
                            const fullPath = (currentFtpPath === '/' ? '' : currentFtpPath) + "/" + arg1;
                            await ftp.remove(normalizeFtpPath(fullPath));
                            socket.emit("ssh-output", `Removed ${fullPath}\r\n`);
                        }
                        else if (cmd === 'cat') {
                            if (!arg1) throw new Error("Usage: cat <path>");
                            const fullPath = (currentFtpPath === '/' ? '' : currentFtpPath) + "/" + arg1;
                            const { Writable } = require('stream');
                            const chunks: any[] = [];
                            const writable = new Writable({
                                write(chunk: any, encoding: any, callback: any) {
                                    chunks.push(chunk);
                                    callback();
                                }
                            });
                            await ftp.downloadTo(writable, normalizeFtpPath(fullPath));
                            const content = Buffer.concat(chunks).toString('utf8');
                            socket.emit("ssh-output", content + "\r\n");
                        }
                        else if (cmd === 'help') {
                            socket.emit("ssh-output", "Supported commands: ls, dir, cd, pwd, mkdir, rm, cat\r\n");
                        }
                        else {
                            socket.emit("ssh-output", `Command not found: ${cmd}\r\n`);
                        }

                    } catch (err: any) {
                        socket.emit("ssh-output", `Error: ${err.message}\r\n`);
                    }
                    socket.emit("ssh-output", "ftp> ");
                }

                // Restore remaining buffer (incomplete line)
                ftpCommandBuffer = remaining;
            }
            return;
        }

        if (sshStream) {
            sshStream.write(data);
        }
    });

    socket.on("resize", ({ cols, rows }) => {
        termCols = cols;
        termRows = rows;
        if (sshStream && typeof sshStream.setWindow === "function") {
            sshStream.setWindow(rows, cols, 0, 0);
        }
    });

    socket.on("disconnect", () => {
        if (conn) conn.end();
        if (ftp) ftp.close();
    });
});

// Global error handling to prevent RDP crashes from killing the server
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

httpServer.listen(PORT, () => {
    console.log(`> Backend ready on http://localhost:${PORT}`);
});
