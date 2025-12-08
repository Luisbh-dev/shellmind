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

// Socket.io Handling
io.on("connection", (socket) => {
    console.log("Client connected", socket.id);

    let sshStream: any = null;
    let sftp: any = null;
    let conn: Client | null = null;
    let termRows = 24;
    let termCols = 80;
    let connectionError: string | null = null;

    // --- SSH Handling ---
    socket.on("start-ssh", (config) => {
        connectionError = null; // Reset error on new attempt
        console.log("Start SSH Config received:", {
            host: config.host,
            user: config.username,
            type: config.type,
            port: config.port,
            passLength: config.password ? config.password.length : 0,
            passFirstChar: config.password ? config.password[0] : 'null'
        });

        const host = config.host?.replace(/[\s\u00A0]+/g, '').trim();
        const username = config.username?.trim() || "root";
        const isWindows = config.type === 'windows';
        const port = config.port || 22;

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

    // --- SFTP Listeners ---
    socket.on("sftp-list", (path) => {
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

    socket.on("sftp-read", (path) => {
        if (!sftp) return socket.emit("sftp-error", "SFTP not initialized");
        // Limit size for safety? For now, simple read.
        // Using fastRead stream or readFile
        sftp.readFile(path, (err: any, buffer: Buffer) => {
            if (err) return socket.emit("sftp-error", "Read error: " + err.message);
            // Send as base64 to avoid binary encoding issues in socket.io json default
            socket.emit("sftp-file-content", { path, data: buffer.toString('base64') });
        });
    });

    socket.on("sftp-write", ({ path, data }) => { // data is base64
        if (!sftp) {
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }
        const buffer = Buffer.from(data, 'base64');
        sftp.writeFile(path, buffer, (err: any) => {
            if (err) return socket.emit("sftp-error", "Write error: " + err.message);
            socket.emit("sftp-write-success", path);
        });
    });

    socket.on("sftp-delete", ({ path, isDir }) => {
        console.log(`[SFTP] Delete request for ${path} (isDir: ${isDir})`);
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

    socket.on("ssh-input", (data) => {
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
