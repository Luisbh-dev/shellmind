import express from "express";
import { createServer } from "http";
import http from "http";
import https from "https";
import { Server } from "socket.io";
import { Client } from "ssh2";
const rdp = require("@electerm/rdpjs");
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import cors from "cors";
import dotenv from "dotenv";
import db from "./database";

dotenv.config();

type AiProvider = "gemini" | "minimax";
type ConfigSource = "env" | "db" | "none";
type ProviderStatus = {
    configured: boolean;
    source: ConfigSource;
};
type ManagedServerRecord = {
    id: number;
    name: string;
    ip: string;
    type: string;
    username?: string;
    password?: string;
    port?: number;
    ssh_port?: number;
    privateKey?: string;
    passphrase?: string;
    os_detail?: string;
};
type StatusDisk = {
    name: string;
    mount: string;
    totalGB: number;
    usedGB: number;
    freeGB: number;
    usagePercent: number;
};
type StatusProcess = {
    pid: number;
    name: string;
    cpuPercent: number;
    memoryPercent?: number;
    memoryMB?: number;
};
type StatusSnapshot = {
    platform: "linux" | "windows";
    hostname: string;
    os: string;
    uptime: string;
    cpuUsagePercent: number;
    memory: {
        totalMB: number;
        usedMB: number;
        freeMB: number;
        usagePercent: number;
    };
    storage: {
        totalGB: number;
        usedGB: number;
        freeGB: number;
        usagePercent: number;
    };
    disks: StatusDisk[];
    processes: StatusProcess[];
    loadAverage?: {
        one: number;
        five: number;
        fifteen: number;
    } | null;
};

const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MINIMAX_PROXY_URL = "https://ia.shellmind.app";
const MINIMAX_PROXY_URL = (process.env.MINIMAX_PROXY_URL?.trim() || DEFAULT_MINIMAX_PROXY_URL).replace(/\/+$/, "");
const MINIMAX_PROXY_BASE_URL = MINIMAX_PROXY_URL.endsWith("/anthropic/v1")
    ? MINIMAX_PROXY_URL
    : `${MINIMAX_PROXY_URL}/anthropic/v1`;
const ALLOW_CLIENT_MINIMAX_KEY = !/^(0|false|no|off)$/i.test(process.env.ALLOW_CLIENT_MINIMAX_KEY || "true");
const MINIMAX_PROXY_API_KEY = process.env.MINIMAX_PROXY_API_KEY?.trim() || "";
const MINIMAX_PROXY_BEARER_TOKEN = process.env.MINIMAX_PROXY_BEARER_TOKEN?.trim() || "";
const AI_PROVIDER_CONFIG: Record<AiProvider, { envKey: string; settingKey: string; label: string }> = {
    gemini: {
        envKey: "GEMINI_API_KEY",
        settingKey: "GEMINI_API_KEY",
        label: "Gemini"
    },
    minimax: {
        envKey: "MINIMAX_API_KEY",
        settingKey: "MINIMAX_API_KEY",
        label: "MiniMax"
    }
};
const MODEL_FALLBACKS: Record<string, string> = {
    "gemini-3-flash-preview": "gemini-2.5-flash",
    "gemini-2.5-flash": "gemma-3-27b-it",
    "gemma-3-27b-it": "gemini-2.5-flash",
    "MiniMax-M3": "MiniMax-M2.7",
    "MiniMax-M2.7": "MiniMax-M2.7",
};
// Anthropic-style max_tokens includes reasoning tokens, so the thinking model
// gets a larger budget or it can exhaust it before emitting any final text.
const DEFAULT_MAX_TOKENS = 6144;
const MODEL_MAX_TOKENS: Record<string, number> = {
    "MiniMax-M3": 16384,
};

type ChatTurn = { role: "user" | "assistant"; content: string };

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_TURN_CHARS = 4000;

// Normalizes the conversation history sent by the frontend into a transcript
// the providers accept: valid roles only, consecutive same-role turns merged,
// oversized turns truncated, and the transcript always starting with "user".
function sanitizeChatHistory(raw: any): ChatTurn[] {
    if (!Array.isArray(raw)) return [];

    const turns: ChatTurn[] = [];
    for (const item of raw) {
        const role = item?.role === "assistant" || item?.role === "user" ? item.role : null;
        const content = typeof item?.content === "string" ? item.content.trim() : "";
        if (!role || !content) continue;

        const text = content.length > MAX_HISTORY_TURN_CHARS
            ? `${content.slice(0, MAX_HISTORY_TURN_CHARS)}\n[...truncated]`
            : content;

        const last = turns[turns.length - 1];
        if (last && last.role === role) {
            last.content += `\n\n${text}`;
        } else {
            turns.push({ role, content: text });
        }
    }

    const recent = turns.slice(-MAX_HISTORY_TURNS);
    while (recent.length && recent[0].role === "assistant") recent.shift();
    return recent;
}

function isAiProvider(value: any): value is AiProvider {
    return value === "gemini" || value === "minimax";
}

function getProviderForModel(modelName: string): AiProvider {
    return modelName.startsWith("MiniMax-") ? "minimax" : "gemini";
}

function getSettingValue(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        db.get("SELECT value FROM settings WHERE key = ?", [key], (err, row: any) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(row?.value ?? null);
        });
    });
}

function setSettingValue(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value], () => resolve());
    });
}

function getDbRow<T>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row: any) => {
            if (err) {
                reject(err);
                return;
            }

            resolve((row as T) ?? null);
        });
    });
}

async function getProviderApiKey(provider: AiProvider): Promise<string | null> {
    const config = AI_PROVIDER_CONFIG[provider];
    const envValue = process.env[config.envKey];
    if (envValue) return envValue;
    return getSettingValue(config.settingKey);
}

async function getProviderStatus(provider: AiProvider): Promise<ProviderStatus> {
    const config = AI_PROVIDER_CONFIG[provider];

    if (process.env[config.envKey]) {
        return { configured: true, source: "env" };
    }

    const savedKey = await getSettingValue(config.settingKey);
    if (savedKey) {
        return { configured: true, source: "db" };
    }

    return { configured: false, source: "none" };
}

function getMiniMaxProxyStatus(providerStatus: ProviderStatus) {
    return {
        enabled: true,
        baseUrl: MINIMAX_PROXY_BASE_URL,
        allowClientKey: ALLOW_CLIENT_MINIMAX_KEY,
        usesProxyAuth: Boolean(MINIMAX_PROXY_API_KEY || MINIMAX_PROXY_BEARER_TOKEN),
        localKeyConfigured: providerStatus.configured,
        localKeySource: providerStatus.source
    };
}

function extractMiniMaxText(payload: any): string {
    return (Array.isArray(payload?.content) ? payload.content : [])
        .filter((block: any) => block?.type === "text" && typeof block?.text === "string")
        .map((block: any) => block.text)
        .join("\n")
        .trim();
}

function shouldRetryMiniMaxWithoutClientKey(statusCode: number, errorMessage: string): boolean {
    const normalized = (errorMessage || "").toLowerCase();

    return [400, 401, 403].includes(statusCode) ||
        normalized.includes("api key") ||
        normalized.includes("x-minimax-api-key") ||
        normalized.includes("unauthorized") ||
        normalized.includes("forbidden") ||
        normalized.includes("invalid") ||
        normalized.includes("authentication");
}

function summarizeMiniMaxPayload(payload: any): string {
    const contentTypes = Array.isArray(payload?.content)
        ? payload.content.map((block: any) => block?.type || "unknown").join(",")
        : "none";
    const stopReason = payload?.stop_reason || "unknown";
    return `stop_reason=${stopReason}; content_types=${contentTypes}`;
}

async function sendMiniMaxProxyRequest(headers: Record<string, string>, body: object): Promise<{
    statusCode: number;
    statusText: string;
    payload: any;
    rawBody: string;
}> {
    const targetUrl = new URL(`${MINIMAX_PROXY_BASE_URL}/messages`);
    const transport = targetUrl.protocol === "http:" ? http : https;
    const bodyText = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const request = transport.request(targetUrl, {
            method: "POST",
            headers: {
                ...headers,
                "content-length": Buffer.byteLength(bodyText).toString()
            }
        }, (response) => {
            const chunks: Buffer[] = [];

            response.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            response.on("end", () => {
                const rawBody = Buffer.concat(chunks).toString("utf8");
                let payload: any = null;

                try {
                    payload = rawBody ? JSON.parse(rawBody) : null;
                } catch {
                    payload = null;
                }

                resolve({
                    statusCode: response.statusCode || 0,
                    statusText: response.statusMessage || "",
                    payload,
                    rawBody
                });
            });
        });

        request.on("error", reject);
        request.write(bodyText);
        request.end();
    });
}

// Streaming variant: forwards Anthropic-style SSE text deltas as they arrive.
// Non-stream upstream responses (errors, or a proxy that ignored `stream`)
// are buffered whole and returned via errorPayload/rawErrorBody instead.
// Aborting `signal` destroys the upstream request, so generation actually
// stops at the proxy instead of running (and billing) to completion.
async function streamMiniMaxProxyRequest(
    headers: Record<string, string>,
    body: object,
    onDelta: (text: string) => void,
    signal?: AbortSignal
): Promise<{
    statusCode: number;
    statusText: string;
    errorPayload: any;
    rawErrorBody: string;
    emittedText: string;
}> {
    const targetUrl = new URL(`${MINIMAX_PROXY_BASE_URL}/messages`);
    const transport = targetUrl.protocol === "http:" ? http : https;
    const bodyText = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const request = transport.request(targetUrl, {
            method: "POST",
            headers: {
                ...headers,
                "content-length": Buffer.byteLength(bodyText).toString()
            }
        }, (response) => {
            const statusCode = response.statusCode || 0;
            const statusText = response.statusMessage || "";
            const isEventStream = String(response.headers["content-type"] || "").includes("text/event-stream");

            if (statusCode >= 400 || !isEventStream) {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                response.on("end", () => {
                    const rawErrorBody = Buffer.concat(chunks).toString("utf8");
                    let errorPayload: any = null;
                    try {
                        errorPayload = rawErrorBody ? JSON.parse(rawErrorBody) : null;
                    } catch {
                        errorPayload = null;
                    }
                    resolve({ statusCode, statusText, errorPayload, rawErrorBody, emittedText: "" });
                });
                response.on("error", reject);
                return;
            }

            let buffer = "";
            let emittedText = "";
            response.setEncoding("utf8");

            response.on("data", (chunk: string) => {
                buffer += chunk;
                let separator;
                while ((separator = buffer.indexOf("\n\n")) !== -1) {
                    const rawEvent = buffer.slice(0, separator);
                    buffer = buffer.slice(separator + 2);

                    for (const line of rawEvent.split("\n")) {
                        if (!line.startsWith("data:")) continue;
                        const dataStr = line.slice(5).trim();
                        if (!dataStr || dataStr === "[DONE]") continue;

                        try {
                            const event = JSON.parse(dataStr);
                            // Thinking deltas are skipped on purpose: only the
                            // final user-facing text reaches the client.
                            if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta" && event.delta.text) {
                                emittedText += event.delta.text;
                                onDelta(event.delta.text);
                            }
                        } catch { /* ignore malformed SSE lines */ }
                    }
                }
            });

            response.on("end", () => resolve({ statusCode, statusText, errorPayload: null, rawErrorBody: "", emittedText }));
            response.on("error", reject);
        });

        if (signal) {
            const onAbort = () => request.destroy(new Error("Client aborted the request"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }

        request.on("error", reject);
        request.write(bodyText);
        request.end();
    });
}

function isRetryableAiError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("429") ||
        normalized.includes("503") ||
        normalized.includes("quota") ||
        normalized.includes("rate limit") ||
        normalized.includes("overloaded") ||
        normalized.includes("timeout");
}

function normalizeAiScopeText(value: string): string {
    return (value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function looksSpanish(text: string): boolean {
    const normalized = normalizeAiScopeText(text);
    return /(^|\b)(hola|quiero|necesito|ayuda|servidor|script|comando|explica|desarrolla|arregla|instala|configura|docker|linux|windows|devops|monitoriza|monitorizacion|logs|backup|despliegue|scraping|webscraping)(\b|$)/.test(normalized);
}

function buildOutOfScopeResponse(message: string): string {
    if (looksSpanish(message)) {
        return "Solo puedo ayudar con tareas de SysAdmin, administracion de servidores y DevOps. Puedo crear comandos o scripts para despliegues, Docker, backups, logs, monitorizacion, redes, hardening, automatizacion, CI/CD y troubleshooting de infraestructura. No puedo ayudar con peticiones de desarrollo general como web scraping, apps, bots, webs, tareas academicas o scripting no relacionado con servidores.";
    }

    return "I can only help with SysAdmin, server management, and DevOps tasks. I can create commands or scripts for deployments, Docker, backups, logs, monitoring, networking, hardening, automation, CI/CD, and infrastructure troubleshooting. I can't help with general development requests such as web scraping, apps, bots, websites, academic tasks, or scripting unrelated to servers.";
}

function isOutOfScopeAiRequest(message: string, context?: string): boolean {
    const normalizedMessage = normalizeAiScopeText(message);
    const normalizedContext = normalizeAiScopeText(context || "");
    const combined = `${normalizedMessage}\n${normalizedContext}`;

    const infraKeywords = [
        "sysadmin", "system administrator", "server", "servidor", "infra", "infrastructure", "devops",
        "docker", "kubernetes", "k8s", "compose", "nginx", "apache", "caddy", "proxy", "reverse proxy",
        "ssh", "rdp", "powershell", "bash", "shell", "systemd", "service", "daemon", "cron",
        "backup", "restore", "snapshot", "monitor", "monitoring", "observability", "metrics",
        "logs", "logging", "deploy", "deployment", "rollout", "rollback", "ansible", "terraform",
        "cloud-init", "ci/cd", "pipeline", "gitlab ci", "github actions", "firewall", "ufw",
        "iptables", "dns", "ssl", "tls", "certbot", "certificate", "network", "networking",
        "port", "sftp", "ftp", "s3", "bucket", "linux", "windows server", "hardening", "audit",
        "vm", "vps", "hostname", "disk", "filesystem", "raid", "postgres", "mysql", "mariadb", "redis"
    ];

    const disallowedKeywords = [
        "web scraping", "webscraping", "scraping", "scraper", "selenium", "beautifulsoup",
        "playwright", "puppeteer", "discord bot", "telegram bot", "twitter bot", "instagram bot",
        "shopify", "landing page", "portfolio", "curriculum", "cv", "resume", "poem", "story",
        "novel", "creative writing", "translate", "translation", "email marketing", "seo",
        "social media", "trading bot", "game", "videojuego", "juego", "web app", "mobile app",
        "react app", "next.js app", "flutter app", "android app", "ios app", "school project",
        "academic", "universidad", "homework", "tarea", "essay", "redaccion"
    ];

    const genericCodingOnlyKeywords = [
        "python script", "javascript", "typescript", "html", "css", "frontend", "backend", "api",
        "web", "website", "app", "application", "program", "programa", "code", "codigo"
    ];

    const hasInfraKeyword = infraKeywords.some(keyword => combined.includes(keyword));
    const hasDisallowedKeyword = disallowedKeywords.some(keyword => normalizedMessage.includes(keyword));
    const hasGenericCodingKeyword = genericCodingOnlyKeywords.some(keyword => normalizedMessage.includes(keyword));

    if (hasDisallowedKeyword && !hasInfraKeyword) {
        return true;
    }

    if (hasGenericCodingKeyword && !hasInfraKeyword) {
        return true;
    }

    return false;
}

function roundTo(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function formatUptime(seconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const days = Math.floor(safeSeconds / 86400);
    const hours = Math.floor((safeSeconds % 86400) / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function normalizePercentage(value: number, total: number): number {
    if (!total || total <= 0) return 0;
    return roundTo((value / total) * 100, 1);
}

function ensureArray<T>(value: T | T[] | null | undefined): T[] {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

function parseLinuxDisks(rawOutput: string): StatusDisk[] {
    return rawOutput
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split(/\s+/);
            if (parts.length < 6) return null;

            // Columns from `df -P -k`: Filesystem 1024-blocks Used Available Capacity Mounted-on
            const [name, totalRaw, usedRaw, freeRaw, usageRaw, ...mountParts] = parts;
            const KB_PER_GB = 1024 * 1024;
            const totalGB = roundTo((parseInt(totalRaw, 10) || 0) / KB_PER_GB, 1);
            const usedGB = roundTo((parseInt(usedRaw, 10) || 0) / KB_PER_GB, 1);
            const freeGB = roundTo((parseInt(freeRaw, 10) || 0) / KB_PER_GB, 1);
            const usagePercent = roundTo(parseFloat(usageRaw.replace('%', '')) || 0, 1);

            return {
                name,
                mount: mountParts.join(' '),
                totalGB,
                usedGB,
                freeGB,
                usagePercent
            } satisfies StatusDisk;
        })
        .filter((disk): disk is StatusDisk => Boolean(disk));
}

function parseLinuxProcesses(rawOutput: string): StatusProcess[] {
    const processes: StatusProcess[] = [];

    for (const line of rawOutput.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
        const match = line.match(/^(\d+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)\s+(\d+)$/);
        if (!match) continue;

        processes.push({
            pid: parseInt(match[1], 10),
            name: match[2],
            cpuPercent: roundTo(parseFloat(match[3].replace(',', '.')), 1),
            memoryPercent: roundTo(parseFloat(match[4].replace(',', '.')), 1),
            memoryMB: roundTo(parseInt(match[5], 10) / 1024, 1)
        });
    }

    return processes;
}

// Fallback parser for busybox/Alpine `ps -o pid,rss,comm` (no %cpu column).
// Sorted by resident memory since CPU% is unavailable in this mode.
function parseBusyboxProcesses(rawOutput: string): StatusProcess[] {
    const rows: StatusProcess[] = [];
    for (const line of rawOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        rows.push({
            pid: parseInt(match[1], 10),
            name: match[3].trim(),
            cpuPercent: 0,
            memoryMB: roundTo((parseInt(match[2], 10) || 0) / 1024, 1)
        });
    }
    return rows.sort((a, b) => (b.memoryMB || 0) - (a.memoryMB || 0)).slice(0, 5);
}

function aggregateStorage(disks: StatusDisk[]) {
    const totals = disks.reduce((acc, disk) => {
        acc.totalGB += disk.totalGB;
        acc.usedGB += disk.usedGB;
        acc.freeGB += disk.freeGB;
        return acc;
    }, { totalGB: 0, usedGB: 0, freeGB: 0 });

    return {
        totalGB: roundTo(totals.totalGB, 1),
        usedGB: roundTo(totals.usedGB, 1),
        freeGB: roundTo(totals.freeGB, 1),
        usagePercent: normalizePercentage(totals.usedGB, totals.totalGB)
    };
}

function execSshCommand(conn: Client, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        conn.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let stdout = "";
            let stderr = "";

            stream.on("close", (code: number | null) => {
                if (code && code !== 0 && stderr.trim()) {
                    reject(new Error(stderr.trim()));
                    return;
                }

                resolve(stdout.trim());
            });

            stream.on("data", (data: any) => {
                stdout += data.toString();
            });

            stream.stderr.on("data", (data: any) => {
                stderr += data.toString();
            });
        });
    });
}

// Tolerant variant: never rejects. A single unsupported command (e.g. on
// busybox/Alpine) returns "" so it degrades that one metric instead of failing
// the whole status panel.
async function execSshSafe(conn: Client, command: string): Promise<string> {
    try {
        return await execSshCommand(conn, command);
    } catch {
        return "";
    }
}

// --- Local CLI / terminal -------------------------------------------------
let nodePtyModule: any = null;
let nodePtyTried = false;
function loadNodePty(): any {
    if (nodePtyTried) return nodePtyModule;
    nodePtyTried = true;
    try {
        nodePtyModule = require("node-pty");
    } catch (e: any) {
        console.warn("node-pty unavailable, local terminals will use basic mode:", e?.message);
        nodePtyModule = null;
    }
    return nodePtyModule;
}

function defaultLocalShell(): { file: string; args: string[] } {
    if (process.platform === "win32") {
        return { file: "powershell.exe", args: ["-NoLogo"] };
    }
    return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

interface LocalTermHandle {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

function startLocalTerminal(
    config: { command?: string; cwd?: string; initialCommand?: string; cols?: number; rows?: number },
    handlers: { onData: (chunk: string) => void; onExit: () => void }
): LocalTermHandle {
    const cols = config.cols || 80;
    const rows = config.rows || 24;
    const cwd = config.cwd && config.cwd.trim()
        ? config.cwd.trim()
        : (process.env.HOME || process.env.USERPROFILE || process.cwd());
    const env = { ...process.env };

    let file: string;
    let args: string[];
    if (config.command && config.command.trim()) {
        const parts = config.command.trim().split(/\s+/);
        file = parts[0];
        args = parts.slice(1);
    } else {
        const base = defaultLocalShell();
        file = base.file;
        args = base.args;
    }

    const sendInitial = (write: (text: string) => void, newline: string) => {
        if (config.initialCommand && config.initialCommand.trim()) {
            const cmd = config.initialCommand.trim();
            setTimeout(() => { try { write(cmd + newline); } catch { /* ignore */ } }, 700);
        }
    };

    const pty = loadNodePty();
    if (pty) {
        const term = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
        term.onData((chunk: string) => handlers.onData(chunk));
        term.onExit(() => handlers.onExit());
        sendInitial((text) => term.write(text), "\r");
        return {
            write: (data) => { try { term.write(data); } catch { /* ignore */ } },
            resize: (c, r) => { try { term.resize(Math.max(1, c), Math.max(1, r)); } catch { /* ignore */ } },
            kill: () => { try { term.kill(); } catch { /* ignore */ } }
        };
    }

    // Fallback when node-pty is not available (degraded: no real TTY).
    const { spawn } = require("child_process");
    handlers.onData("\r\n[ShellMind] node-pty not available — basic mode (limited interactivity).\r\n");
    const child = spawn(file, args, { cwd, env });
    child.stdout?.on("data", (chunk: Buffer) => handlers.onData(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => handlers.onData(chunk.toString()));
    child.on("exit", () => handlers.onExit());
    child.on("error", (err: any) => handlers.onData(`\r\n[ShellMind] Failed to start '${file}': ${err.message}\r\n`));
    sendInitial((text) => child.stdin?.write(text), "\n");
    return {
        write: (data) => { try { child.stdin?.write(data); } catch { /* ignore */ } },
        resize: () => { /* no-op without a PTY */ },
        kill: () => { try { child.kill(); } catch { /* ignore */ } }
    };
}

/**
 * Scoped CLI console: shows a `<bin>>` prompt and runs each entered line as
 * `<bin> <args>` without giving access to the underlying shell. `exit`/`quit`
 * closes it. Each command is executed via child_process through the system
 * shell (so PATH and .cmd/.bat wrappers like az/gcloud resolve), which keeps
 * the output clean — unlike a per-command conpty, which would clear the screen.
 */
function startScopedCli(
    config: {
        bin: string;
        cwd?: string;
        banner?: string;
        initialCommand?: string;
        subcommands?: string[];
        initialHistory?: string[];
        onHistoryChange?: (history: string[]) => void;
    },
    handlers: { onData: (chunk: string) => void; onExit: () => void }
): LocalTermHandle {
    const cwd = config.cwd && config.cwd.trim()
        ? config.cwd.trim()
        : (process.env.HOME || process.env.USERPROFILE || process.cwd());
    const env = { ...process.env };
    const bin = config.bin;
    const subcommands = config.subcommands || [];
    const promptLabel = `\x1b[36m${bin}>\x1b[0m `;
    const history: string[] = (config.initialHistory || []).slice(-100);
    let histIdx = history.length;

    let mode: "prompt" | "running" = "prompt";
    let line = "";
    let child: any = null;
    let closed = false;

    const writePrompt = () => { if (!closed) handlers.onData("\r\n" + promptLabel); };
    // Redraw the current input line in place (used for history recall).
    const redrawLine = () => { if (!closed) handlers.onData("\r\x1b[K" + promptLabel + line); };
    const recall = (delta: number) => {
        if (!history.length) return;
        histIdx = Math.max(0, Math.min(history.length, histIdx + delta));
        line = histIdx < history.length ? history[histIdx] : "";
        redrawLine();
    };

    const commonPrefix = (arr: string[]) => {
        if (!arr.length) return "";
        let p = arr[0];
        for (const s of arr) { while (!s.startsWith(p)) p = p.slice(0, -1); }
        return p;
    };
    // Tab-complete the first token against the tool's common subcommands.
    const complete = () => {
        if (!subcommands.length || /\s/.test(line)) return;
        const matches = subcommands.filter((s) => s.startsWith(line.toLowerCase()));
        if (!matches.length) return;
        if (matches.length === 1) {
            line = matches[0] + " ";
            redrawLine();
        } else {
            const common = commonPrefix(matches);
            if (common.length > line.length) line = common;
            handlers.onData("\r\n" + matches.join("   ") + "\r\n" + promptLabel + line);
        }
    };

    const finishChild = () => {
        child = null;
        mode = "prompt";
        line = "";
        writePrompt();
    };

    const runLine = (raw: string) => {
        let input = raw.trim();

        // Tolerate pasted/AI-generated lines that echo the console prompt or
        // repeat the tool name: "docker> ps", "docker> docker ps" and
        // "docker docker ps" all normalize to "ps".
        input = input.replace(new RegExp(`^(?:${bin}>\\s*)+`, "i"), "").trim();
        while (new RegExp(`^${bin}(?:\\s+${bin})+(?:\\s|$)`, "i").test(input)) {
            input = input.replace(new RegExp(`^${bin}\\s+`, "i"), "").trim();
        }

        if (!input) { writePrompt(); return; }
        const lower = input.toLowerCase();
        if (lower === "exit" || lower === "quit") { handlers.onData("\r\n"); handlers.onExit(); return; }
        if (lower === "clear" || lower === "cls") { handlers.onData("\x1b[2J\x1b[H"); writePrompt(); return; }

        // Ensure the command targets the scoped tool (so both "ps" and
        // "docker ps" work), then run it THROUGH the shell so PATH and
        // .cmd/.bat wrappers (az, gcloud) resolve correctly.
        const firstTok = input.split(/\s+/)[0]?.toLowerCase();
        const fullCmd = firstTok === bin.toLowerCase() ? input : `${bin} ${input}`;
        const isWin = process.platform === "win32";
        const shellFile = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
        const shellArgs = isWin ? ["/d", "/s", "/c", fullCmd] : ["-c", fullCmd];
        handlers.onData("\r\n");

        try {
            const { spawn } = require("child_process");
            const cp = spawn(shellFile, shellArgs, { cwd, env, windowsHide: true });
            child = cp; mode = "running";
            // Normalize bare LF to CRLF so the terminal doesn't stair-step.
            const emit = (d: Buffer) => handlers.onData(d.toString().replace(/\r?\n/g, "\r\n"));
            cp.stdout?.on("data", emit);
            cp.stderr?.on("data", emit);
            cp.on("close", () => finishChild());
            cp.on("error", (e: any) => { handlers.onData(`${bin}: ${e.message}\r\n`); finishChild(); });
        } catch (e: any) {
            handlers.onData(`${bin}: ${e?.message || e}\r\n`);
            finishChild();
        }
    };

    // Banner + first prompt (and optional auto-run of the context command).
    setTimeout(() => {
        if (closed) return;
        if (config.banner) handlers.onData(config.banner);
        if (config.initialCommand && config.initialCommand.trim()) {
            runLine(config.initialCommand.trim());
        } else {
            writePrompt();
        }
    }, 60);

    return {
        write: (data) => {
            if (closed) return;
            if (mode === "running" && child) {
                // Ctrl+C cancels the running command; everything else is stdin.
                if (data.includes("\x03")) { try { child.kill(); } catch { /* ignore */ } }
                else { try { child.stdin?.write(data); } catch { /* ignore */ } }
                return;
            }
            // Prompt mode: line editor with echo, history (↑/↓) and Ctrl+L.
            for (let i = 0; i < data.length; i++) {
                const ch = data[i];
                if (ch === "\x1b") {
                    // Arrow keys: ESC [ A / ESC O A (up), B (down).
                    const intro = data[i + 1];
                    const code = data[i + 2];
                    if ((intro === "[" || intro === "O") && (code === "A" || code === "B")) {
                        recall(code === "A" ? -1 : 1);
                        i += 2;
                    } else {
                        // Skip any other escape sequence up to its final byte.
                        let j = i + 1;
                        while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++;
                        i = j;
                    }
                    continue;
                }
                if (ch === "\r" || ch === "\n") {
                    const current = line.trim();
                    if (current && history[history.length - 1] !== current) {
                        history.push(current);
                        if (history.length > 100) history.shift();
                        config.onHistoryChange?.(history.slice());
                    }
                    histIdx = history.length;
                    const submitted = line; line = "";
                    runLine(submitted);
                } else if (ch === "\t") {
                    complete();
                } else if (ch === "\x7f" || ch === "\b") {
                    if (line.length) { line = line.slice(0, -1); handlers.onData("\b \b"); }
                } else if (ch === "\x03") {
                    line = ""; handlers.onData("^C"); writePrompt();
                } else if (ch === "\x0c") {
                    // Ctrl+L: clear the screen but keep the current line.
                    handlers.onData("\x1b[2J\x1b[H" + promptLabel + line);
                } else if (ch >= " ") {
                    line += ch; handlers.onData(ch);
                }
            }
        },
        resize: () => { /* pipe-based; nothing to resize */ },
        kill: () => {
            closed = true;
            try { if (child) child.kill(); } catch { /* ignore */ }
        }
    };
}

// Common subcommands per tool, used for Tab-completion in the scoped console.
const CLI_SUBCOMMANDS: Record<string, string[]> = {
    docker: ["ps", "images", "pull", "push", "run", "exec", "logs", "build", "compose", "network", "volume", "inspect", "stop", "start", "restart", "rm", "rmi", "stats", "system", "login", "info", "version", "top", "cp", "tag", "save", "load"],
    kubectl: ["get", "describe", "apply", "delete", "logs", "exec", "config", "rollout", "scale", "port-forward", "top", "version", "cluster-info", "create", "edit", "explain", "expose", "run", "cordon", "drain"],
    aws: ["s3", "ec2", "sts", "iam", "lambda", "dynamodb", "cloudformation", "logs", "configure", "ecr", "ecs", "eks", "ssm", "rds", "route53", "sns", "sqs", "cloudwatch"],
    az: ["account", "group", "vm", "storage", "login", "logout", "aks", "webapp", "network", "ad", "keyvault", "acr", "appservice", "functionapp", "sql", "cosmosdb", "monitor", "role", "version"],
    gcloud: ["config", "compute", "auth", "projects", "container", "storage", "app", "functions", "run", "sql", "iam", "logging", "services", "components"]
};

// Known CLI presets → the binary we expect on PATH + official install docs.
const CLI_PRESET_INFO: Record<string, { bin: string; name: string; url: string }> = {
    azure: { bin: "az", name: "Azure CLI", url: "https://learn.microsoft.com/cli/azure/install-azure-cli" },
    aws: { bin: "aws", name: "AWS CLI", url: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" },
    gcloud: { bin: "gcloud", name: "Google Cloud CLI", url: "https://cloud.google.com/sdk/docs/install" },
    kubectl: { bin: "kubectl", name: "kubectl", url: "https://kubernetes.io/docs/tasks/tools/" },
    docker: { bin: "docker", name: "Docker", url: "https://docs.docker.com/get-docker/" }
};

// Returns true if `bin` is resolvable on PATH. Never throws.
function checkCommandExists(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const { exec } = require("child_process");
            const cmd = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
            exec(cmd, { timeout: 4000, windowsHide: true }, (err: any) => resolve(!err));
        } catch {
            resolve(true); // if the check itself fails, don't block the session
        }
    });
}

// Best-effort one-line context for the chat greeting: the tool's version for a
// scoped CLI (`<bin> --version`), or the host OS for a local shell. Never throws.
function detectLocalContext(bin?: string): Promise<string> {
    if (bin) {
        return new Promise((resolve) => {
            try {
                const { exec } = require("child_process");
                exec(`${bin} --version`, { timeout: 5000, windowsHide: true }, (_e: any, stdout: string, stderr: string) => {
                    const first = `${stdout || ""}\n${stderr || ""}`
                        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
                    if (!first || /not recognized|not found|no such file|cannot find/i.test(first)) resolve("");
                    else resolve(first.slice(0, 100));
                });
            } catch { resolve(""); }
        });
    }
    try {
        const os = require("os");
        return Promise.resolve(`${os.type()} ${os.release()}`);
    } catch {
        return Promise.resolve("");
    }
}

function connectSsh(server: ManagedServerRecord): Promise<Client> {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        const isWindows = server.type === "windows";
        const port = isWindows ? (server.ssh_port || 22) : (server.port || 22);

        conn.on("ready", () => resolve(conn));
        conn.on("error", (error) => reject(error));

        conn.connect({
            host: server.ip,
            port,
            username: server.username?.trim() || "root",
            password: server.password,
            privateKey: server.privateKey,
            passphrase: server.passphrase,
            tryKeyboard: false,
            hostVerifier: () => true,
            readyTimeout: 20000
        });
    });
}

async function getLinuxStatus(conn: Client): Promise<StatusSnapshot> {
    const [
        hostname,
        os,
        uptimeSecondsRaw,
        cpuSampleRaw,
        memoryRaw,
        disksRaw,
        processesRaw,
        loadRaw
    ] = await Promise.all([
        execSshSafe(conn, "hostname"),
        execSshSafe(conn, "sh -c 'if [ -f /etc/os-release ]; then . /etc/os-release && printf \"%s\" \"$PRETTY_NAME\"; else uname -sr; fi'"),
        execSshSafe(conn, "sh -c 'cut -d. -f1 /proc/uptime'"),
        // Portable CPU usage: two /proc/stat samples 1s apart; the percentage is computed in Node.
        execSshSafe(conn, "sh -c 'read _ u n s id wa hi si rest < /proc/stat; t1=$((u+n+s+id+wa+hi+si)); i1=$((id+wa)); sleep 1; read _ u n s id wa hi si rest < /proc/stat; t2=$((u+n+s+id+wa+hi+si)); i2=$((id+wa)); echo $((t2-t1)) $((i2-i1))'"),
        execSshSafe(conn, "sh -c \"awk '/MemTotal/ {total=$2} /MemAvailable/ {avail=$2} END {printf \\\"%d %d\\\", int(total/1024), int(avail/1024)}' /proc/meminfo\""),
        execSshSafe(conn, "sh -c 'df -P -k 2>/dev/null | tail -n +2'"),
        execSshSafe(conn, "sh -c 'ps -eo pid,comm,%cpu,%mem,rss --sort=-%cpu 2>/dev/null | head -n 6 | tail -n +2'"),
        execSshSafe(conn, "sh -c 'cat /proc/loadavg'")
    ]);

    const [totalMemoryMB, freeMemoryMB] = memoryRaw.split(/\s+/).map(value => parseInt(value, 10) || 0);
    const usedMemoryMB = Math.max(0, totalMemoryMB - freeMemoryMB);
    const disks = parseLinuxDisks(disksRaw);
    const storage = aggregateStorage(disks);
    const [one = 0, five = 0, fifteen = 0] = loadRaw.split(/\s+/).map(value => parseFloat(value) || 0);

    // CPU usage from the two /proc/stat samples ("<totalDelta> <idleDelta>").
    const [cpuTotalDelta = 0, cpuIdleDelta = 0] = cpuSampleRaw.split(/\s+/).map(value => parseInt(value, 10) || 0);
    const cpuUsagePercent = cpuTotalDelta > 0
        ? roundTo(Math.min(100, Math.max(0, (1 - cpuIdleDelta / cpuTotalDelta) * 100)), 1)
        : 0;

    // Top processes: GNU ps first; on busybox/Alpine fall back to a memory-sorted listing.
    let processes = parseLinuxProcesses(processesRaw);
    if (processes.length === 0) {
        const fallbackRaw = await execSshSafe(conn, "sh -c 'ps -o pid,rss,comm 2>/dev/null | tail -n +2'");
        processes = parseBusyboxProcesses(fallbackRaw);
    }

    return {
        platform: "linux",
        hostname,
        os,
        uptime: formatUptime(parseInt(uptimeSecondsRaw, 10)),
        cpuUsagePercent,
        memory: {
            totalMB: totalMemoryMB,
            usedMB: usedMemoryMB,
            freeMB: freeMemoryMB,
            usagePercent: normalizePercentage(usedMemoryMB, totalMemoryMB)
        },
        storage,
        disks,
        processes,
        loadAverage: {
            one: roundTo(one, 2),
            five: roundTo(five, 2),
            fifteen: roundTo(fifteen, 2)
        }
    };
}

async function getWindowsStatus(conn: Client): Promise<StatusSnapshot> {
    const summaryRaw = await execSshCommand(
        conn,
        `powershell -NoProfile -Command "$os=Get-CimInstance Win32_OperatingSystem; $cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; [pscustomobject]@{ hostname=$env:COMPUTERNAME; os=$os.Caption; uptime=((Get-Date)-$os.LastBootUpTime).ToString('dd\\.hh\\:mm\\:ss'); cpuUsagePercent=[math]::Round($cpu,2); totalMemoryMB=[math]::Round($os.TotalVisibleMemorySize/1024,2); freeMemoryMB=[math]::Round($os.FreePhysicalMemory/1024,2) } | ConvertTo-Json -Compress"`
    );
    const disksRaw = await execSshCommand(
        conn,
        `powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object @{N='name';E={$_.DeviceID}}, @{N='mount';E={$_.DeviceID}}, @{N='totalGB';E={[math]::Round($_.Size/1GB,1)}}, @{N='freeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}, @{N='usedGB';E={[math]::Round(($_.Size-$_.FreeSpace)/1GB,1)}}, @{N='usagePercent';E={if($_.Size -gt 0){[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100,1)}else{0}}} | ConvertTo-Json -Compress"`
    );
    const processesRaw = await execSshCommand(
        conn,
        `powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 @{N='pid';E={$_.Id}}, @{N='name';E={$_.ProcessName}}, @{N='cpuPercent';E={[math]::Round($_.CPU,1)}}, @{N='memoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress"`
    );

    const summary = JSON.parse(summaryRaw);
    const disks = ensureArray<any>(JSON.parse(disksRaw)).map((disk) => ({
        name: disk.name,
        mount: disk.mount,
        totalGB: Number(disk.totalGB) || 0,
        usedGB: Number(disk.usedGB) || 0,
        freeGB: Number(disk.freeGB) || 0,
        usagePercent: Number(disk.usagePercent) || 0
    })) satisfies StatusDisk[];
    const storage = aggregateStorage(disks);
    const totalMemoryMB = Number(summary.totalMemoryMB) || 0;
    const freeMemoryMB = Number(summary.freeMemoryMB) || 0;
    const usedMemoryMB = roundTo(Math.max(0, totalMemoryMB - freeMemoryMB), 1);

    return {
        platform: "windows",
        hostname: summary.hostname,
        os: summary.os,
        uptime: summary.uptime,
        cpuUsagePercent: Number(summary.cpuUsagePercent) || 0,
        memory: {
            totalMB: totalMemoryMB,
            usedMB: usedMemoryMB,
            freeMB: freeMemoryMB,
            usagePercent: normalizePercentage(usedMemoryMB, totalMemoryMB)
        },
        storage,
        disks,
        processes: ensureArray<any>(JSON.parse(processesRaw)).map((process) => ({
            pid: Number(process.pid) || 0,
            name: process.name,
            cpuPercent: Number(process.cpuPercent) || 0,
            memoryMB: Number(process.memoryMB) || 0
        })),
        loadAverage: null
    };
}

async function callMiniMaxCompatibleAnthropicApi(
    clientApiKey: string | null,
    modelName: string,
    systemPrompt: string,
    history: ChatTurn[],
    userMessage: string,
    onDelta?: (text: string) => void,
    signal?: AbortSignal
): Promise<string> {
    // Anthropic-compatible messages must alternate roles and start with "user";
    // sanitizeChatHistory guarantees that, so only the final turn needs merging.
    const buildMessages = (finalUserText: string) => {
        const turns: ChatTurn[] = history.map(turn => ({ ...turn }));
        const last = turns[turns.length - 1];

        if (last && last.role === "user") {
            last.content += `\n\n${finalUserText}`;
        } else {
            turns.push({ role: "user", content: finalUserText });
        }

        return turns.map(turn => ({
            role: turn.role,
            content: [
                {
                    type: "text",
                    text: turn.content
                }
            ]
        }));
    };

    const buildHeaders = (includeClientKey: boolean) => {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01"
        };

        if (MINIMAX_PROXY_API_KEY) {
            headers["x-api-key"] = MINIMAX_PROXY_API_KEY;
        }

        if (MINIMAX_PROXY_BEARER_TOKEN) {
            headers["authorization"] = `Bearer ${MINIMAX_PROXY_BEARER_TOKEN}`;
        }

        if (includeClientKey && clientApiKey) {
            headers["x-minimax-api-key"] = clientApiKey;
        }

        return headers;
    };

    const buildBody = (finalUserText: string, stream: boolean) => ({
        model: modelName,
        max_tokens: MODEL_MAX_TOKENS[modelName] || DEFAULT_MAX_TOKENS,
        system: systemPrompt,
        messages: buildMessages(finalUserText),
        ...(stream ? { stream: true } : {})
    });

    const sendRequest = (includeClientKey: boolean, finalUserText: string) =>
        sendMiniMaxProxyRequest(buildHeaders(includeClientKey), buildBody(finalUserText, false));

    const shouldUseClientKey = ALLOW_CLIENT_MINIMAX_KEY && Boolean(clientApiKey);

    if (onDelta) {
        const streamOnce = (includeClientKey: boolean, finalUserText: string) =>
            streamMiniMaxProxyRequest(buildHeaders(includeClientKey), buildBody(finalUserText, true), onDelta, signal);

        const errorMessageOf = (result: { errorPayload: any; statusText: string; rawErrorBody: string }) =>
            result.errorPayload?.error?.message || result.errorPayload?.message || result.statusText || result.rawErrorBody || "Unknown MiniMax API error";

        let result = await streamOnce(shouldUseClientKey, userMessage);

        // 4xx responses never stream deltas, so retrying cannot duplicate text.
        if (result.statusCode >= 400 && shouldUseClientKey && shouldRetryMiniMaxWithoutClientKey(result.statusCode, errorMessageOf(result))) {
            console.warn("[MiniMax Proxy] Client MiniMax key failed (stream). Retrying with managed proxy key.");
            result = await streamOnce(false, userMessage);
        }

        // The proxy answered OK but as plain JSON (stream not honored).
        if (result.statusCode < 400 && !result.emittedText && result.errorPayload) {
            const text = extractMiniMaxText(result.errorPayload);
            if (text) {
                onDelta(text);
                return text;
            }
        }

        // Stream finished with thinking only — force a final answer.
        if (result.statusCode < 400 && !result.emittedText) {
            console.warn("[MiniMax Proxy] Stream had no final text. Retrying with forced final answer.");
            result = await streamOnce(false, `${userMessage}\n\nIMPORTANT: Return a final user-facing answer as a text block. Do not return thinking only.`);
        }

        if (result.statusCode >= 400) {
            throw new Error(`${result.statusCode} ${errorMessageOf(result)}`.trim());
        }

        if (!result.emittedText) {
            throw new Error("MiniMax returned no final text content (stream).");
        }

        return result.emittedText;
    }
    let { statusCode, statusText, payload, rawBody } = await sendRequest(shouldUseClientKey, userMessage);
    let text = extractMiniMaxText(payload);

    if (statusCode >= 400 && shouldUseClientKey) {
        const errorMessage = payload?.error?.message || payload?.message || statusText || rawBody || "Unknown MiniMax API error";

        if (shouldRetryMiniMaxWithoutClientKey(statusCode, errorMessage)) {
            console.warn("[MiniMax Proxy] Client MiniMax key failed. Retrying with managed proxy key.");
            ({ statusCode, statusText, payload, rawBody } = await sendRequest(false, userMessage));
            text = extractMiniMaxText(payload);
        }
    }

    if (statusCode < 400 && !text && shouldUseClientKey) {
        console.warn("[MiniMax Proxy] Response had no final text with client key. Retrying with managed proxy key.");
        ({ statusCode, statusText, payload, rawBody } = await sendRequest(false, userMessage));
        text = extractMiniMaxText(payload);
    }

    if (statusCode < 400 && !text) {
        const forcedFinalPrompt = `${userMessage}\n\nIMPORTANT: Return a final user-facing answer as a text block. Do not return thinking only.`;
        console.warn(`[MiniMax Proxy] Response had no final text. Retrying with forced final answer. ${summarizeMiniMaxPayload(payload)}`);
        ({ statusCode, statusText, payload, rawBody } = await sendRequest(false, forcedFinalPrompt));
        text = extractMiniMaxText(payload);
    }

    if (statusCode >= 400) {
        const errorMessage = payload?.error?.message || payload?.message || statusText || rawBody || "Unknown MiniMax API error";
        throw new Error(`${statusCode} ${errorMessage}`.trim());
    }

    if (!text) {
        const payloadSummary = payload ? summarizeMiniMaxPayload(payload) : `non_json_body=${rawBody.slice(0, 180) || "empty"}`;
        throw new Error(`MiniMax returned no final text content. ${payloadSummary}`);
    }

    return text;
}

// Browser pages from arbitrary origins must not be able to read this API or
// drive the socket (credential/command access). Allowed: requests with no
// Origin (curl, same-origin) or "null" (the Electron build loads via file://),
// localhost on any port (Vite dev, the bundled app), and any extra origins
// listed in the ALLOWED_ORIGINS env var (comma-separated, for web deploys).
const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin || origin === "null") return true;

    try {
        const { hostname } = new URL(origin);
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
            return true;
        }
    } catch {
        return false;
    }

    return EXTRA_ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""));
}

const corsOriginCheck = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    callback(null, isAllowedOrigin(origin));
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: corsOriginCheck,
        methods: ["GET", "POST"]
    },
    // CORS only gates the polling handshake; raw WebSocket upgrades are not
    // subject to CORS, so the Origin header is verified here as well.
    allowRequest: (req, callback) => {
        callback(null, isAllowedOrigin(req.headers.origin));
    },
    transports: ['websocket', 'polling'], // Allow both but prefer websocket
    maxHttpBufferSize: 1e7 // 10 MB — uploads are chunked, but keep headroom per message
});

app.use(cors({ origin: corsOriginCheck }));
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001; // Backend port

// --- API Routes ---

// Get all servers.
// Secrets (password, private key, passphrase, S3 secret) never leave the
// backend: connections are made by server id and credentials are resolved
// from the database server-side. The has_* flags let the edit UI show that
// a secret is already saved.
app.get("/api/servers", (req, res) => {
    const sql = `SELECT
            id, name, ip, type, username, port, ssh_port, os_detail,
            s3_provider, s3_bucket, s3_region, s3_endpoint, s3_access_key,
            command, cwd, initial_command, cli_preset,
            (password IS NOT NULL AND password != '') AS has_password,
            (privateKey IS NOT NULL AND privateKey != '') AS has_private_key,
            (passphrase IS NOT NULL AND passphrase != '') AS has_passphrase,
            (s3_secret_key IS NOT NULL AND s3_secret_key != '') AS has_s3_secret_key
        FROM servers`;

    db.all(sql, [], (err, rows) => {
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
    console.log("POST /api/servers received body:", { ...req.body, password: "***", privateKey: "***", passphrase: "***", s3_secret_key: "***" });
    try {
        const { name, ip, type, username, password, port, ssh_port, s3_provider, s3_bucket, s3_region, s3_endpoint, s3_access_key, s3_secret_key, privateKey, passphrase, command, cwd, initial_command, cli_preset } = req.body;
        const sql = "INSERT INTO servers (name, ip, type, username, password, port, ssh_port, s3_provider, s3_bucket, s3_region, s3_endpoint, s3_access_key, s3_secret_key, privateKey, passphrase, command, cwd, initial_command, cli_preset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
        // For Linux: port is SSH. For Windows: port is RDP, ssh_port is SSH.
        const params = [
            name,
            ip,
            type,
            username,
            password,
            port || (type === 'windows' ? 3389 : 22),
            ssh_port || 22,
            s3_provider,
            s3_bucket,
            s3_region,
            s3_endpoint,
            s3_access_key,
            s3_secret_key,
            req.body.privateKey,
            req.body.passphrase,
            command,
            cwd,
            initial_command,
            cli_preset
        ];

        db.run(sql, params, function (err) {
            if (err) {
                console.error("Database Insert Error:", err.message);
                res.status(500).json({ "error": err.message });
                return;
            }
            console.log("Server added with ID:", this.lastID);
            const { password: _pw, privateKey: _pk, passphrase: _pp, s3_secret_key: _sk, ...publicFields } = req.body;
            res.json({
                "message": "success",
                "data": { id: this.lastID, ...publicFields }
            });
        });
    } catch (e: any) {
        console.error("Exception in POST /api/servers:", e);
        res.status(500).json({ "error": e.message });
    }
});

// Update an existing server.
// The edit form never receives saved secrets, so a blank/absent secret field
// means "keep the stored value". Non-secret fields are overwritten as before.
app.put("/api/servers/:id", (req, res) => {
    console.log("PUT /api/servers/" + req.params.id, { ...req.body, password: "***", privateKey: "***", passphrase: "***", s3_secret_key: "***" });
    const { name, ip, type, username, password, port, os_detail, ssh_port, s3_provider, s3_bucket, s3_region, s3_endpoint, s3_access_key, s3_secret_key, privateKey, passphrase, command, cwd, initial_command, cli_preset } = req.body;
    const keepIfBlank = (value: any) => (typeof value === "string" && value.trim() !== "" ? value : null);
    const sql = `UPDATE servers SET
            name = ?, ip = ?, type = ?, username = ?,
            password = COALESCE(?, password),
            port = ?, os_detail = ?, ssh_port = ?,
            s3_provider = ?, s3_bucket = ?, s3_region = ?, s3_endpoint = ?, s3_access_key = ?,
            s3_secret_key = COALESCE(?, s3_secret_key),
            privateKey = COALESCE(?, privateKey),
            passphrase = COALESCE(?, passphrase),
            command = ?, cwd = ?, initial_command = ?, cli_preset = ?
        WHERE id = ?`;
    const params = [
        name,
        ip,
        type,
        username,
        keepIfBlank(password),
        port || (type === 'windows' ? 3389 : 22),
        os_detail,
        ssh_port || 22,
        s3_provider,
        s3_bucket,
        s3_region,
        s3_endpoint,
        s3_access_key,
        keepIfBlank(s3_secret_key),
        keepIfBlank(privateKey),
        keepIfBlank(passphrase),
        command,
        cwd,
        initial_command,
        cli_preset,
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

app.get("/api/servers/:id/status", async (req, res) => {
    try {
        const server = await getDbRow<ManagedServerRecord>("SELECT * FROM servers WHERE id = ?", [req.params.id]);

        if (!server) {
            return res.status(404).json({ error: "Server not found" });
        }

        if (server.type === "ftp" || server.type === "s3") {
            return res.status(400).json({ error: "Status dashboard is only available for SSH-capable servers." });
        }

        const conn = await connectSsh(server);

        try {
            const snapshot = server.type === "windows"
                ? await getWindowsStatus(conn)
                : await getLinuxStatus(conn);

            res.json(snapshot);
        } finally {
            conn.end();
        }
    } catch (error: any) {
        console.error("Status dashboard error:", error);
        res.status(500).json({ error: error.message || "Failed to collect server status" });
    }
});


// --- Configuration Routes ---

// Check if API Key is configured
app.get("/api/config/status", async (req, res) => {
    try {
        const providers = {
            gemini: await getProviderStatus("gemini"),
            minimax: await getProviderStatus("minimax")
        };

        res.json({
            configured: providers.gemini.configured,
            source: providers.gemini.source,
            providers,
            features: {
                minimaxProxy: getMiniMaxProxyStatus(providers.minimax)
            }
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Set API Key (only if not in env)
app.post("/api/config/apikey", (req, res) => {
    const provider: AiProvider = isAiProvider(req.body.provider) ? req.body.provider : "gemini";
    const providerConfig = AI_PROVIDER_CONFIG[provider];

    if (provider === "minimax" && !ALLOW_CLIENT_MINIMAX_KEY) {
        return res.status(403).json({
            error: "MiniMax client keys are disabled. This app sends MiniMax traffic through the managed proxy."
        });
    }

    if (process.env[providerConfig.envKey]) {
        return res.status(403).json({ error: `${providerConfig.label} API Key is already set via Environment Variables.` });
    }

    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "Key is required" });

    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [providerConfig.settingKey, key], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "success" });
    });
});

// Delete API Key (only if not in env)
app.delete("/api/config/apikey", (req, res) => {
    const provider: AiProvider = isAiProvider(req.body?.provider) ? req.body.provider : "gemini";
    const providerConfig = AI_PROVIDER_CONFIG[provider];

    if (provider === "minimax" && !ALLOW_CLIENT_MINIMAX_KEY) {
        return res.status(403).json({
            error: "MiniMax client keys are disabled. This app sends MiniMax traffic through the managed proxy."
        });
    }

    if (process.env[providerConfig.envKey]) {
        return res.status(403).json({ error: `${providerConfig.label} API Key is already set via Environment Variables.` });
    }

    db.run("DELETE FROM settings WHERE key = ?", [providerConfig.settingKey], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "success", changes: this.changes });
    });
});

// Get Preferred Model
app.get("/api/config/model", (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'PREFERRED_MODEL'", [], (err, row: any) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ model: row ? row.value : DEFAULT_MODEL });
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

// --- Per-server chat history (so conversations survive reloads/switches) ---

const MAX_PERSISTED_CHAT_MESSAGES = 100;

app.get("/api/chat/history/:serverId", (req, res) => {
    db.get("SELECT messages FROM chat_history WHERE server_id = ?", [String(req.params.serverId)], (err, row: any) => {
        if (err) return res.status(500).json({ error: err.message });

        let messages: any[] = [];
        try {
            messages = row?.messages ? JSON.parse(row.messages) : [];
        } catch {
            messages = [];
        }

        res.json({ messages: Array.isArray(messages) ? messages : [] });
    });
});

app.put("/api/chat/history/:serverId", (req, res) => {
    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!incoming) return res.status(400).json({ error: "messages array is required" });

    const messages = incoming
        .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.trim())
        .slice(-MAX_PERSISTED_CHAT_MESSAGES)
        .map((m: any) => ({ role: m.role, content: m.content }));

    db.run(
        "INSERT OR REPLACE INTO chat_history (server_id, messages, updated_at) VALUES (?, ?, ?)",
        [String(req.params.serverId), JSON.stringify(messages), Date.now()],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "success", count: messages.length });
        }
    );
});

app.delete("/api/chat/history/:serverId", (req, res) => {
    db.run("DELETE FROM chat_history WHERE server_id = ?", [String(req.params.serverId)], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "deleted", changes: this.changes });
    });
});

// Chat API Route.
// Default mode answers with a single JSON payload. With `stream: true` in the
// body it answers as Server-Sent Events instead:
//   {type:"model", model}        — a model attempt starts (fallbacks included)
//   {type:"delta", text}         — incremental answer text
//   {type:"done", usedModel, fullText} — canonical final text (post-fixups)
//   {type:"error", message}
// Closing the SSE connection aborts the upstream provider request.
app.post("/api/chat", async (req: any, res: any) => {
    const wantsStream = req.body?.stream === true;
    const upstreamAbort = new AbortController();
    let sseStarted = false;
    let sseFinished = false;

    const sseStart = () => {
        if (sseStarted) return;
        sseStarted = true;
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });
        res.flushHeaders?.();
        res.on("close", () => {
            if (!sseFinished) upstreamAbort.abort();
        });
    };

    const sseSend = (payload: object) => {
        if (!sseStarted || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const sseEnd = () => {
        sseFinished = true;
        if (sseStarted && !res.writableEnded) res.end();
    };

    const replyCanned = (text: string) => {
        if (wantsStream) {
            sseStart();
            sseSend({ type: "delta", text });
            sseSend({ type: "done", usedModel: null, fullText: text });
            sseEnd();
            return;
        }
        res.json({ response: text });
    };

    try {
        const { message, context, model: requestedModel, history } = req.body;
        const chatHistory = sanitizeChatHistory(history);

        // The keyword pre-filter is blunt (e.g. "code"/"api" trip it), so it
        // only gates the first turn; ongoing conversations are governed by the
        // scope rules in the system prompt.
        if (chatHistory.length === 0 && isOutOfScopeAiRequest(message, context)) {
            return replyCanned(buildOutOfScopeResponse(message));
        }

        // Determine Model
        let targetModel = requestedModel;
        if (!targetModel) {
            const preferredModel = await getSettingValue("PREFERRED_MODEL");
            targetModel = preferredModel || DEFAULT_MODEL;
        }

        const targetProvider = getProviderForModel(targetModel);
        const apiKey = await getProviderApiKey(targetProvider);
        const isMiniMaxProxyMode = targetProvider === "minimax";

        if (targetProvider === "gemini" && !apiKey) {
            return replyCanned(`Please set your ${AI_PROVIDER_CONFIG[targetProvider].envKey} in Settings or Environment variables.`);
        }

        console.log(`[Chat] Using ${AI_PROVIDER_CONFIG[targetProvider].label} model: ${targetModel}${isMiniMaxProxyMode ? ` via proxy ${MINIMAX_PROXY_BASE_URL}${ALLOW_CLIENT_MINIMAX_KEY && apiKey ? " with client key" : ""}` : ""}`);

        const genAI = targetProvider === "gemini" && apiKey ? new GoogleGenerativeAI(apiKey) : null;

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

    7. **TERMINAL PROMPT & ENVIRONMENT AWARENESS (CRITICAL)**:
       - Code blocks must contain ONLY the runnable command. NEVER include the terminal prompt inside a code block: no \`$\`, \`#\`, \`PS C:\\>\`, \`docker>\`, \`az>\`, \`kubectl>\`, etc. Prompts you see in the terminal output are NOT part of commands.
       - Adapt every command to the EXACT environment described in the System Context.
       - If the context says this is a SCOPED tool console (e.g. a "docker>" console), output ONLY that tool's subcommands: write \`ps -a\`, NOT \`docker ps -a\` and NOT \`docker> ps\`. The console prepends the tool name itself. Other programs, pipes and shell syntax are unavailable there.

    8. **STRICT SCOPE LIMIT**:
       - You ONLY help with SysAdmin, server management, infrastructure automation, CI/CD, containers, networking, backups, monitoring, logging, security hardening, cloud/server deployments, and troubleshooting of server environments.
       - You MAY write Bash, PowerShell, Python, or other scripts ONLY when the script is directly related to server administration or DevOps operations.
       - You MUST REFUSE requests for general software development unrelated to server operations.
       - You MUST REFUSE requests such as web scraping, generic web/app development, bots, academic assignments, marketing content, translations, essays, stories, or unrelated coding tasks.
       - When refusing, briefly explain the scope and redirect the user toward a server-management or DevOps version of the request.
    
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

        const systemWithContext = `${SYSTEM_PROMPT}\n\n[System Context: ${context || 'None'}]`;

        let streamedChars = 0;
        const onDelta = wantsStream
            ? (textDelta: string) => {
                streamedChars += textDelta.length;
                sseSend({ type: "delta", text: textDelta });
            }
            : undefined;

        const tryGenerate = async (modelName: string) => {
            console.log(`[Chat] Attempting with model: ${modelName}`);
            if (wantsStream) sseSend({ type: "model", model: modelName });

            if (getProviderForModel(modelName) === "minimax") {
                return callMiniMaxCompatibleAnthropicApi(apiKey, modelName, systemWithContext, chatHistory, message, onDelta, upstreamAbort.signal);
            }

            if (!genAI) {
                throw new Error("Gemini client is not available.");
            }

            const model = genAI.getGenerativeModel({
                model: modelName,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                ]
            });

            // Gemma models reject systemInstruction, so the system prompt rides as
            // a synthetic opening exchange that works across the whole family.
            const geminiTurns = chatHistory.map(turn => ({ ...turn }));
            let outgoingMessage = message;
            const lastTurn = geminiTurns[geminiTurns.length - 1];
            if (lastTurn && lastTurn.role === "user") {
                geminiTurns.pop();
                outgoingMessage = `${lastTurn.content}\n\n${message}`;
            }

            const chat = model.startChat({
                history: [
                    { role: "user", parts: [{ text: systemWithContext }] },
                    { role: "model", parts: [{ text: "Understood. I will follow these rules and the provided server context." }] },
                    ...geminiTurns.map(turn => ({
                        role: turn.role === "assistant" ? "model" : "user",
                        parts: [{ text: turn.content }]
                    }))
                ]
            });

            if (onDelta) {
                const result = await chat.sendMessageStream(outgoingMessage);
                let fullText = "";
                for await (const chunk of result.stream) {
                    if (upstreamAbort.signal.aborted) break;
                    const chunkText = chunk.text();
                    if (chunkText) {
                        fullText += chunkText;
                        onDelta(chunkText);
                    }
                }
                return fullText;
            }

            const result = await chat.sendMessage(outgoingMessage);
            const response = await result.response;
            return response.text();
        };

        if (wantsStream) sseStart();

        let text: string;
        let usedModel = targetModel;

        try {
            text = await tryGenerate(targetModel);
        } catch (err: any) {
            if (upstreamAbort.signal.aborted) {
                sseEnd();
                return;
            }

            console.error(`[Chat] Error with ${targetModel}:`, err.message);

            // Check for retryable errors (Quota, Overloaded, Timeout)
            const isRetryable = isRetryableAiError(err.message);

            const fallbackModel = MODEL_FALLBACKS[targetModel];

            // Once text has been streamed to the client, switching models would
            // duplicate the answer — surface the error instead.
            if (isRetryable && fallbackModel && streamedChars === 0) {
                console.log(`[Chat] ⚠️ Quota/Error limit reached. Auto-switching to fallback: ${fallbackModel}`);
                usedModel = fallbackModel;
                try {
                    text = await tryGenerate(fallbackModel);
                } catch (fallbackErr: any) {
                    throw new Error(`All models failed. Primary: ${err.message}. Fallback: ${fallbackErr.message}`);
                }
            } else {
                throw err;
            }
        }

        // --- HOTFIX: Gemma 3 Auto-Correction ---
        // The model persistently starts commands with '-Command' despite instructions.
        // We enforce the correction here before sending to frontend.

        // Fix 1: Replace "-Command" at start of lines with "powershell -Command"
        text = text.replace(/^-Command\s+/gm, 'powershell -Command ');

        // Fix 2: If it generates "powershell -Command" inside a bash block, allow it,
        // but if it generates raw cmdlets without wrapper, we might miss them,
        // but the -Command pattern is the most frequent error.

        if (wantsStream) {
            sseSend({ type: "done", usedModel, fullText: text });
            sseEnd();
            return;
        }

        res.json({ response: text, usedModel: usedModel });
    } catch (error: any) {
        if (upstreamAbort.signal.aborted) {
            sseEnd();
            return;
        }

        console.error("Error calling AI provider:", error);

        if (wantsStream) {
            sseStart();
            sseSend({ type: "error", message: "Error processing your request: " + error.message });
            sseEnd();
            return;
        }

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

function joinRemotePath(parentPath: string, childName: string): string {
    const cleanParent = (parentPath || '').trim().replace(/\/+$/, '');
    const cleanChild = (childName || '').trim().replace(/^\/+/, '');

    if (!cleanChild) return cleanParent || '/';
    if (!cleanParent || cleanParent === '/') return `/${cleanChild}`;
    return `${cleanParent}/${cleanChild}`;
}

function buildS3FolderKey(parentPath: string, childName: string): string {
    let cleanParent = (parentPath || '').trim().replace(/\/+$/, '');
    let cleanChild = (childName || '').trim().replace(/^\/+|\/+$/g, '');

    if (cleanParent.startsWith('/')) cleanParent = cleanParent.substring(1);
    if (!cleanChild) return cleanParent ? `${cleanParent}/` : '';

    const key = cleanParent ? `${cleanParent}/${cleanChild}` : cleanChild;
    return key.endsWith('/') ? key : `${key}/`;
}

function buildS3ObjectKey(parentPath: string, childName: string): string {
    const fullPath = joinRemotePath(parentPath, childName);
    return fullPath.startsWith('/') ? fullPath.substring(1) : fullPath;
}

function encodeS3CopySource(bucket: string, key: string): string {
    return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
}

// Socket.io Handling
// Connections are requested by server id; credentials are looked up here and
// never travel through the client. The raw config fields act only as a
// fallback for ad-hoc connections that were never saved.
async function resolveConnectionConfig(config: any): Promise<any> {
    if (config?.serverId == null) return config;

    try {
        const row = await getDbRow<any>("SELECT * FROM servers WHERE id = ?", [config.serverId]);
        if (!row) return config;

        return {
            ...config,
            password: row.password || undefined,
            privateKey: row.privateKey || undefined,
            passphrase: row.passphrase || undefined,
            s3_access_key: row.s3_access_key || undefined,
            s3_secret_key: row.s3_secret_key || undefined
        };
    } catch (err: any) {
        console.error("Failed to resolve credentials for server", config.serverId, err?.message);
        return config;
    }
}

io.on("connection", (socket) => {
    console.log("Client connected", socket.id);

    let sshStream: any = null;
    let sftp: any = null; // SSH2 SFTP Wrapper
    let ftp: any = null;  // Basic-FTP Client
    let s3Client: S3Client | null = null;
    let s3Bucket: string = "";
    let localTerm: LocalTermHandle | null = null; // Local CLI / pty session
    let connectionType: 'ssh' | 'ftp' | 's3' | 'local' = 'ssh';
    let uploadState: {
        path: string;
        sftpStream?: any;        // ssh2 SFTP write stream
        pass?: any;              // PassThrough feeding FTP uploadFrom / S3 multipart Upload
        done?: Promise<any>;     // resolves when the FTP/S3 upload finishes
        s3Upload?: any;          // @aws-sdk/lib-storage Upload instance (for abort)
    } | null = null;
    let ftpInProgress = false;
    let rdpClient: any = null; // RDP Client
    const bitmapQueue: any[] = [];
    let bitmapFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let bitmapBatchMaxTimer: ReturnType<typeof setTimeout> | null = null;
    const BITMAP_BATCH_IDLE_MS = 120;
    const BITMAP_BATCH_MAX_MS = 500;

    let conn: Client | null = null;
    let termRows = 24;
    let termCols = 80;
    let connectionError: string | null = null;

    const flushBitmapQueue = () => {
        if (!bitmapQueue.length) return;
        if (bitmapFlushTimer) {
            clearTimeout(bitmapFlushTimer);
            bitmapFlushTimer = null;
        }
        if (bitmapBatchMaxTimer) {
            clearTimeout(bitmapBatchMaxTimer);
            bitmapBatchMaxTimer = null;
        }
        const batch = bitmapQueue.splice(0, bitmapQueue.length);
        socket.emit("rdp-bitmap-batch", batch);
    };

    const scheduleBitmapFlush = () => {
        if (bitmapFlushTimer) {
            clearTimeout(bitmapFlushTimer);
        }
        bitmapFlushTimer = setTimeout(() => {
            bitmapFlushTimer = null;
            flushBitmapQueue();
        }, BITMAP_BATCH_IDLE_MS);

        if (!bitmapBatchMaxTimer) {
            bitmapBatchMaxTimer = setTimeout(() => {
                bitmapBatchMaxTimer = null;
                flushBitmapQueue();
            }, BITMAP_BATCH_MAX_MS);
        }
    };

    const clearBitmapFlush = () => {
        if (bitmapFlushTimer) {
            clearTimeout(bitmapFlushTimer);
            bitmapFlushTimer = null;
        }
        if (bitmapBatchMaxTimer) {
            clearTimeout(bitmapBatchMaxTimer);
            bitmapBatchMaxTimer = null;
        }
        bitmapQueue.length = 0;
    };

    // --- SSH / FTP Connection Handling ---
    socket.on("start-ssh", async (rawConfig) => {
        const config = await resolveConnectionConfig(rawConfig);
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
        if (localTerm) { localTerm.kill(); localTerm = null; }
        sftp = null;
        s3Client = null;

        if (config.type === 'local') {
            connectionType = 'local';
            try {
                const handlers = {
                    onData: (chunk: string) => socket.emit("ssh-output", chunk),
                    onExit: () => {
                        socket.emit("ssh-output", "\r\n[ShellMind] Session ended.\r\n");
                        socket.emit("ssh-closed");
                    }
                };

                // Known cloud/container CLIs run as a SCOPED console (a `<bin>>`
                // prompt that only executes that tool's subcommands), not a full
                // shell. "shell"/"custom" presets still open the real shell.
                const presetInfo = CLI_PRESET_INFO[(config.cli_preset || "").toLowerCase()];
                if (presetInfo) {
                    const exists = await checkCommandExists(presetInfo.bin);
                    const banner =
                        `\x1b[2m${presetInfo.name} console — type subcommands (e.g. "ps"). Tab to complete, ↑/↓ history, 'exit' to close.\x1b[0m\r\n` +
                        (exists ? "" : `\x1b[33m'${presetInfo.bin}' was not found on PATH. Install: ${presetInfo.url}\x1b[0m\r\n`);

                    // Per-server command history persisted in the settings table.
                    const serverId = config.serverId;
                    const historyKey = serverId != null ? `cli_history:${serverId}` : null;
                    let initialHistory: string[] = [];
                    if (historyKey) {
                        try {
                            const raw = await getSettingValue(historyKey);
                            if (raw) initialHistory = JSON.parse(raw);
                        } catch { /* ignore corrupt history */ }
                    }

                    localTerm = startScopedCli(
                        {
                            bin: presetInfo.bin,
                            cwd: config.cwd,
                            banner,
                            initialCommand: exists ? config.initialCommand : undefined,
                            subcommands: CLI_SUBCOMMANDS[presetInfo.bin] || [],
                            initialHistory,
                            onHistoryChange: historyKey
                                ? (hist) => { void setSettingValue(historyKey, JSON.stringify(hist)); }
                                : undefined
                        },
                        handlers
                    );
                } else {
                    localTerm = startLocalTerminal(
                        {
                            command: config.command,
                            cwd: config.cwd,
                            initialCommand: config.initialCommand,
                            cols: termCols,
                            rows: termRows
                        },
                        handlers
                    );
                }
                socket.emit("connection-ready");

                // Surface the tool/OS version to the chat greeting (best-effort).
                detectLocalContext(presetInfo ? presetInfo.bin : undefined)
                    .then((detail) => { if (detail) socket.emit("os-detected", detail); })
                    .catch(() => { /* ignore */ });
            } catch (err: any) {
                console.error("Local terminal error:", err);
                socket.emit("ssh-error", "Local terminal error: " + (err?.message || err));
            }
            return;
        }

        if (config.type === 's3') {
            console.log("Switched connectionType to S3");
            connectionType = 's3';
            s3Bucket = config.s3_bucket;

            try {
                const s3Config: any = {
                    region: config.s3_region || "us-east-1",
                    credentials: {
                        accessKeyId: config.s3_access_key,
                        secretAccessKey: config.s3_secret_key
                    }
                };

                if (config.s3_provider === 'other' && config.s3_endpoint) {
                    let endpoint = config.s3_endpoint.trim();
                    // Ensure protocol is present
                    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
                        endpoint = 'https://' + endpoint;
                    }
                    s3Config.endpoint = endpoint;
                    s3Config.forcePathStyle = true; // Often needed for MinIO/others
                }

                console.log("S3 Config used:", JSON.stringify({ ...s3Config, credentials: { accessKeyId: '***', secretAccessKey: '***' } })); // Debug log
                s3Client = new S3Client(s3Config);

                // Test connection by listing 1 object? 
                // We'll just assume ready and let list fail if bad.
                console.log("S3 Client Initialized");
                socket.emit("ssh-output", `\r\nConnected to S3 Bucket: ${s3Bucket}\r\n`);
                socket.emit("connection-ready");

            } catch (err: any) {
                console.error("S3 Init Error:", err);
                socket.emit("ssh-error", "S3 Error: " + err.message);
            }
            return;
        }

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
                    socket.emit("ssh-closed");
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
                privateKey: config.privateKey,
                passphrase: config.passphrase,
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
        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");

            try {
                // Determine prefix from path.
                // If path is "/" or "", prefix is empty. 
                // If path is "/folder", prefix is "folder/"
                let prefix = path;
                if (prefix.startsWith('/')) prefix = prefix.substring(1);
                if (prefix && !prefix.endsWith('/')) prefix += '/';
                if (prefix === '/') prefix = ''; // Root

                console.log(`[S3 List] Bucket: ${s3Bucket}, Prefix: '${prefix}'`);

                const command = new ListObjectsV2Command({
                    Bucket: s3Bucket,
                    Prefix: prefix,
                    Delimiter: '/'
                });

                const response = await s3Client.send(command);

                const files: any[] = [];
                const seen = new Set<string>();

                // CommonPrefixes are directories
                if (response.CommonPrefixes) {
                    response.CommonPrefixes.forEach((p) => {
                        const name = p.Prefix?.split('/').filter(x => x).pop();
                        if (name && !seen.has(`dir:${name}`)) {
                            seen.add(`dir:${name}`);
                            files.push({
                                name: name,
                                isDir: true,
                                size: 0,
                                mtime: 0,
                                permissions: 0
                            });
                        }
                    });
                }

                // Contents are files
                if (response.Contents) {
                    response.Contents.forEach((c) => {
                        // Skip the folder object itself if it exists (key ending in / equal to prefix)
                        if (c.Key === prefix) return;

                        const isFolderMarker = !!c.Key?.endsWith('/');
                        const cleanKey = isFolderMarker ? c.Key?.replace(/\/$/, '') : c.Key;
                        const name = cleanKey?.split('/').filter(x => x).pop();
                        if (name) {
                            const dedupeKey = `${isFolderMarker ? 'dir' : 'file'}:${name}`;
                            if (seen.has(dedupeKey)) return;
                            seen.add(dedupeKey);
                            files.push({
                                name: name,
                                isDir: isFolderMarker,
                                size: c.Size || 0,
                                mtime: c.LastModified ? new Date(c.LastModified).getTime() / 1000 : 0,
                                permissions: 0
                            });
                        }
                    });
                }

                files.sort((a: any, b: any) => {
                    if (a.isDir === b.isDir) return a.name.localeCompare(b.name);
                    return a.isDir ? -1 : 1;
                });

                socket.emit("sftp-files", { path, files });

            } catch (err: any) {
                console.error("S3 List Error:", err);
                socket.emit("sftp-error", "S3 List Error: " + err.message);
            }
            return;
        }

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
        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");

            try {
                let key = path;
                if (key.startsWith('/')) key = key.substring(1);

                console.log(`[S3 Read] Bucket: ${s3Bucket}, Key: '${key}'`);

                const command = new GetObjectCommand({
                    Bucket: s3Bucket,
                    Key: key
                });

                const response = await s3Client.send(command);
                const str = await response.Body?.transformToString("base64");

                if (str) {
                    socket.emit("sftp-file-content", { path, data: str });
                } else {
                    throw new Error("Empty body");
                }
            } catch (err: any) {
                console.error("S3 Read Error:", err);
                socket.emit("sftp-error", "S3 Read Error: " + err.message);
            }
            return;
        }

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

        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");

            try {
                let key = path;
                if (key.startsWith('/')) key = key.substring(1);

                console.log(`[S3 Write] Bucket: ${s3Bucket}, Key: '${key}'`);

                const command = new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: key,
                    Body: buffer
                });

                await s3Client.send(command);
                socket.emit("sftp-write-success", path);
            } catch (err: any) {
                console.error("S3 Write Error:", err);
                socket.emit("sftp-error", "S3 Write Error: " + err.message);
            }
            return;
        }

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

    // --- Chunked upload (large files + progress) ---------------------------
    // Protocol: start -> (chunk -> ack)* -> end. Each chunk is acked so the
    // client streams with backpressure instead of sending the whole file in one
    // socket message (which would exceed maxHttpBufferSize and drop the upload).
    socket.on("sftp-upload-start", ({ path }) => {
        try { uploadState?.sftpStream?.destroy?.(); } catch { /* ignore */ }
        try { uploadState?.pass?.destroy?.(); } catch { /* ignore */ }
        try { uploadState?.s3Upload?.abort?.(); } catch { /* ignore */ }
        uploadState = null;

        try {
            const { PassThrough } = require("stream");

            if (connectionType === 's3') {
                if (!s3Client) return socket.emit("sftp-upload-error", "S3 not initialized");
                const { Upload } = require("@aws-sdk/lib-storage");
                let key = path;
                if (key.startsWith("/")) key = key.substring(1);
                const pass = new PassThrough();
                // Multipart streaming: parts are flushed to S3 as data arrives —
                // no full-file buffering and no 5 GB single-PutObject cap.
                const up = new Upload({
                    client: s3Client,
                    params: { Bucket: s3Bucket, Key: key, Body: pass },
                    queueSize: 4,
                    partSize: 5 * 1024 * 1024
                });
                const done = up.done();
                done.catch((err: any) => {
                    if (uploadState && uploadState.pass === pass) {
                        uploadState = null;
                        socket.emit("sftp-upload-error", "S3 Write Error: " + err.message);
                    }
                });
                uploadState = { path, pass, done, s3Upload: up };
            } else if (connectionType === 'ftp') {
                if (!ftp || ftp.closed) return socket.emit("sftp-upload-error", "FTP not initialized");
                const pass = new PassThrough();
                const done = ftp.uploadFrom(pass, normalizeFtpPath(path));
                done.catch((err: any) => {
                    if (uploadState && uploadState.pass === pass) {
                        uploadState = null;
                        socket.emit("sftp-upload-error", "FTP Write Error: " + err.message);
                    }
                });
                uploadState = { path, pass, done };
            } else {
                if (!sftp) return socket.emit("sftp-upload-error", connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection.");
                const stream = sftp.createWriteStream(path);
                stream.on("error", (err: any) => {
                    uploadState = null;
                    socket.emit("sftp-upload-error", "Write error: " + err.message);
                });
                uploadState = { path, sftpStream: stream };
            }
            socket.emit("sftp-upload-ready", path);
        } catch (err: any) {
            socket.emit("sftp-upload-error", err?.message || String(err));
        }
    });

    socket.on("sftp-upload-chunk", (data: string) => {
        if (!uploadState) return socket.emit("sftp-upload-error", "No active upload");
        let buffer: Buffer;
        try { buffer = Buffer.from(data, "base64"); } catch { return socket.emit("sftp-upload-error", "Bad chunk"); }

        try {
            if (uploadState.pass) {
                uploadState.pass.write(buffer, () => socket.emit("sftp-upload-ack"));
            } else if (uploadState.sftpStream) {
                uploadState.sftpStream.write(buffer, () => socket.emit("sftp-upload-ack"));
            } else {
                socket.emit("sftp-upload-error", "No active upload");
            }
        } catch (err: any) {
            socket.emit("sftp-upload-error", err?.message || String(err));
        }
    });

    socket.on("sftp-upload-end", async () => {
        const state = uploadState;
        if (!state) return socket.emit("sftp-upload-error", "No active upload");
        uploadState = null;
        try {
            if (state.pass) {
                // FTP and S3 both finish when the source stream ends.
                state.pass.end();
                await state.done;
                socket.emit("sftp-write-success", state.path);
            } else if (state.sftpStream) {
                await new Promise<void>((resolve, reject) => {
                    state.sftpStream.once("error", reject);
                    state.sftpStream.end(() => resolve());
                });
                socket.emit("sftp-write-success", state.path);
            }
        } catch (err: any) {
            socket.emit("sftp-upload-error", err?.message || String(err));
        }
    });

    socket.on("sftp-upload-cancel", () => {
        const state = uploadState;
        uploadState = null;
        try { state?.sftpStream?.destroy?.(); } catch { /* ignore */ }
        try { state?.pass?.destroy?.(new Error("cancelled")); } catch { /* ignore */ }
        try { state?.s3Upload?.abort?.(); } catch { /* ignore */ }
    });

    socket.on("sftp-mkdir", async ({ parentPath, name }) => {
        const fullPath = joinRemotePath(parentPath, name);
        console.log(`[Mkdir] Request parent='${parentPath}' name='${name}' => '${fullPath}' via ${connectionType}`);

        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");

            try {
                const key = buildS3FolderKey(parentPath, name);
                if (!key) throw new Error("Usage: mkdir <folder-name>");

                const command = new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: key,
                    Body: Buffer.alloc(0)
                });

                await s3Client.send(command);
                socket.emit("sftp-mkdir-success", fullPath);
            } catch (err: any) {
                console.error("S3 Mkdir Error:", err);
                socket.emit("sftp-mkdir-error", "S3 Mkdir Error: " + err.message);
                socket.emit("sftp-error", "S3 Mkdir Error: " + err.message);
            }
            return;
        }

        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not initialized");

            try {
                const ftpParent = normalizeFtpPath(parentPath || '/').trim() || '/';
                const folderName = (name || '').trim();
                if (!folderName) throw new Error("Usage: mkdir <path>");

                const originalCwd = await ftp.pwd();
                try {
                    await ftp.cd(ftpParent);
                    await ftp.ensureDir(folderName);
                } finally {
                    if (originalCwd) {
                        await ftp.cd(originalCwd);
                    }
                }

                socket.emit("sftp-mkdir-success", fullPath);
            } catch (err: any) {
                socket.emit("sftp-mkdir-error", "FTP Mkdir Error: " + err.message);
                socket.emit("sftp-error", "FTP Mkdir Error: " + err.message);
            }
            return;
        }

        if (!sftp) {
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }

        sftp.mkdir(fullPath, { mode: 0o755 }, (err: any) => {
            if (err) {
                socket.emit("sftp-mkdir-error", "Mkdir error: " + err.message);
                return socket.emit("sftp-error", "Mkdir error: " + err.message);
            }
            socket.emit("sftp-mkdir-success", fullPath);
        });
    });

    socket.on("sftp-rename", async ({ parentPath, oldName, newName, isDir }) => {
        const oldFullPath = joinRemotePath(parentPath, oldName);
        const newFullPath = joinRemotePath(parentPath, newName);
        console.log(`[Rename] Request parent='${parentPath}' old='${oldName}' new='${newName}' => '${oldFullPath}' -> '${newFullPath}' via ${connectionType}`);

        if (oldFullPath === newFullPath) {
            return socket.emit("sftp-rename-error", "Nothing changed.");
        }

        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");
            const s3 = s3Client;

            try {
                if (isDir) {
                    const sourcePrefix = buildS3FolderKey(parentPath, oldName);
                    const destPrefix = buildS3FolderKey(parentPath, newName);

                    if (!sourcePrefix || !destPrefix) throw new Error("Usage: rename <name>");

                    const listCmd = new ListObjectsV2Command({
                        Bucket: s3Bucket,
                        Prefix: sourcePrefix
                    });

                    const response = await s3.send(listCmd);
                    const objects = response.Contents || [];
                    if (!objects.length) {
                        throw new Error("Folder not found");
                    }

                    await Promise.all(objects.map(async (obj) => {
                        if (!obj.Key) return;
                        const suffix = obj.Key.substring(sourcePrefix.length);
                        const destKey = `${destPrefix}${suffix}`;
                        const copyCmd = new CopyObjectCommand({
                            Bucket: s3Bucket,
                            CopySource: encodeS3CopySource(s3Bucket, obj.Key),
                            Key: destKey
                        });
                        await s3.send(copyCmd);
                    }));

                    await s3.send(new DeleteObjectsCommand({
                        Bucket: s3Bucket,
                        Delete: {
                            Objects: objects
                                .filter((obj) => !!obj.Key)
                                .map((obj) => ({ Key: obj.Key as string }))
                        }
                    }));
                } else {
                    const sourceKey = buildS3ObjectKey(parentPath, oldName);
                    const destKey = buildS3ObjectKey(parentPath, newName);

                    if (!sourceKey || !destKey) throw new Error("Usage: rename <name>");

                    await s3.send(new CopyObjectCommand({
                        Bucket: s3Bucket,
                        CopySource: encodeS3CopySource(s3Bucket, sourceKey),
                        Key: destKey
                    }));

                    await s3.send(new DeleteObjectCommand({
                        Bucket: s3Bucket,
                        Key: sourceKey
                    }));
                }

                socket.emit("sftp-rename-success", {
                    parentPath,
                    oldName,
                    newName,
                    isDir,
                    oldPath: oldFullPath,
                    newPath: newFullPath
                });
            } catch (err: any) {
                console.error("S3 Rename Error:", err);
                socket.emit("sftp-rename-error", "S3 Rename Error: " + err.message);
                socket.emit("sftp-error", "S3 Rename Error: " + err.message);
            }
            return;
        }

        if (connectionType === 'ftp') {
            if (!ftp || ftp.closed) return socket.emit("sftp-error", "FTP not initialized");

            try {
                const sourcePath = normalizeFtpPath(oldFullPath);
                const destinationPath = normalizeFtpPath(newFullPath);
                await ftp.rename(sourcePath, destinationPath);

                socket.emit("sftp-rename-success", {
                    parentPath,
                    oldName,
                    newName,
                    isDir,
                    oldPath: oldFullPath,
                    newPath: newFullPath
                });
            } catch (err: any) {
                socket.emit("sftp-rename-error", "FTP Rename Error: " + err.message);
                socket.emit("sftp-error", "FTP Rename Error: " + err.message);
            }
            return;
        }

        if (!sftp) {
            const msg = connectionError ? `SFTP Error: ${connectionError}` : "Unable to establish file connection. Please ensure the server is reachable.";
            return socket.emit("sftp-error", msg);
        }

        sftp.rename(oldFullPath, newFullPath, (err: any) => {
            if (err) {
                socket.emit("sftp-rename-error", "Rename error: " + err.message);
                return socket.emit("sftp-error", "Rename error: " + err.message);
            }
            socket.emit("sftp-rename-success", {
                parentPath,
                oldName,
                newName,
                isDir,
                oldPath: oldFullPath,
                newPath: newFullPath
            });
        });
    });

    socket.on("sftp-delete", async ({ path, isDir }) => {
        console.log(`[Delete] Request for ${path} (isDir: ${isDir}) via ${connectionType}`);

        if (connectionType === 's3') {
            if (!s3Client) return socket.emit("sftp-error", "S3 not initialized");

            try {
                let key = path;
                if (key.startsWith('/')) key = key.substring(1);

                console.log(`[S3 Delete] Bucket: ${s3Bucket}, Key: '${key}', IsDir: ${isDir}`);

                if (isDir) {
                    // For 'folders', we must delete everything with that prefix
                    if (!key.endsWith('/')) key += '/';

                    // List all objects with prefix
                    const listCmd = new ListObjectsV2Command({
                        Bucket: s3Bucket,
                        Prefix: key
                    });

                    const listRes = await s3Client.send(listCmd);

                    if (listRes.Contents && listRes.Contents.length > 0) {
                        const objectsToDelete = listRes.Contents.map(obj => ({ Key: obj.Key }));

                        const deleteCmd = new DeleteObjectsCommand({
                            Bucket: s3Bucket,
                            Delete: { Objects: objectsToDelete }
                        });

                        await s3Client.send(deleteCmd);
                    }
                    // Also delete the folder marker if it exists? (sometimes folders are 0-byte objects)
                    // The scan above covers it if it matches prefix.

                } else {
                    const command = new DeleteObjectCommand({
                        Bucket: s3Bucket,
                        Key: key
                    });
                    await s3Client.send(command);
                }

                socket.emit("sftp-delete-success", path);
            } catch (err: any) {
                console.error("S3 Delete Error:", err);
                socket.emit("sftp-error", "S3 Delete Error: " + err.message);
            }
            return;
        }

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
        if (connectionType === 'local') {
            localTerm?.write(data);
            return;
        }

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
        localTerm?.resize(cols, rows);
    });

    // --- RDP Connection Handling ---
    socket.on("start-rdp", async (rawConfig) => {
        const config = await resolveConnectionConfig(rawConfig);
        console.log("[RDP] Start connection:", { host: config.host, port: config.port, user: config.username });

        // Clean up previous RDP session
        if (rdpClient) {
            try { rdpClient.close(); } catch (e) { }
            rdpClient = null;
        }

        const host = config.host?.replace(/[\s\u00A0]+/g, '').trim();
        const port = config.port || 3389;
        const screenWidth = config.screenWidth || 1280;
        const screenHeight = config.screenHeight || 800;

        try {
            rdpClient = rdp.createClient({
                domain: config.domain || '',
                userName: config.username || '',
                password: config.password || '',
                enablePerf: false,
                autoLogin: true,
                decompress: true,
                screen: { width: screenWidth, height: screenHeight },
                locale: 'en',
                logLevel: 'ERROR'
            });

            // Pass credentials for NLA/CredSSP handshake
            if (rdpClient.x224) {
                rdpClient.x224.nlaCredentials = {
                    domain: config.domain || '',
                    username: config.username || '',
                    password: config.password || ''
                };
            }

            rdpClient.on('connect', () => {
                console.log("[RDP] Connected to", host);
                socket.emit("rdp-connect");
            });

            rdpClient.on('bitmap', (bitmap: any) => {
                const originalIsCompress = !!bitmap.isCompress;
                if (!rdpClient._hasLoggedBitmap) {
                    const debugInfo = {
                        w: bitmap.width, h: bitmap.height,
                        top: bitmap.destTop, left: bitmap.destLeft, right: bitmap.destRight, bottom: bitmap.destBottom,
                        bpp: bitmap.bitsPerPixel, compress: bitmap.isCompress,
                        dataLength: bitmap.data.length
                    };
                    console.log("SERVER BITMAP DUMP:", debugInfo);
                    rdpClient._hasLoggedBitmap = true;
                }

                bitmapQueue.push({
                    destTop: bitmap.destTop,
                    destLeft: bitmap.destLeft,
                    destBottom: bitmap.destBottom,
                    destRight: bitmap.destRight,
                    width: bitmap.width,
                    height: bitmap.height,
                    bitsPerPixel: bitmap.bitsPerPixel,
                    isCompress: bitmap.isCompress,
                    sourceCompressed: originalIsCompress,
                    data: bitmap.data
                });
                scheduleBitmapFlush();
            });

            rdpClient.on('close', () => {
                console.log("[RDP] Connection closed");
                clearBitmapFlush();
                socket.emit("rdp-closed");
                rdpClient = null;
            });

            rdpClient.on('error', (err: any) => {
                console.error("[RDP] Error:", err);
                const message = typeof err === 'string' ? err : (err?.message || 'Unknown RDP error');
                socket.emit("rdp-error", message);
            });

            rdpClient.connect(host, port);

        } catch (err: any) {
            clearBitmapFlush();
            console.error("[RDP] Init Error:", err);
            socket.emit("rdp-error", "RDP Init Error: " + err.message);
        }
    });

    socket.on("rdp-mouse", (data) => {
        if (rdpClient) {
            try {
                rdpClient.sendPointerEvent(data.x, data.y, data.button, data.isPressed);
            } catch (e) { }
        }
    });

    socket.on("rdp-keyboard", (data) => {
        if (rdpClient) {
            try {
                if (data.unicode) {
                    rdpClient.sendKeyEventUnicode(data.code, data.isPressed);
                } else {
                    rdpClient.sendKeyEventScancode(data.code, data.isPressed);
                }
            } catch (e) { }
        }
    });

    socket.on("rdp-disconnect", () => {
        console.log("[RDP] Client requested disconnect");
        clearBitmapFlush();
        if (rdpClient) {
            try { rdpClient.close(); } catch (e) { }
            rdpClient = null;
        }
    });

    // --- Native RDP Launch (mstsc.exe) ---
    socket.on("launch-rdp-native", async (rawConfig) => {
        const config = await resolveConnectionConfig(rawConfig);
        const { exec } = require('child_process');
        const host = config.host?.replace(/[\s\u00A0]+/g, '').trim();
        const port = config.port || 3389;
        const target = `TERMSRV/${host}`;
        const username = config.username || '';
        const password = config.password || '';
        const domain = config.domain || '';
        const fullUser = domain ? `${domain}\\${username}` : username;

        console.log("[RDP Native] Launching mstsc.exe for", host);

        try {
            // Store credentials temporarily
            await new Promise<void>((resolve, reject) => {
                exec(`cmdkey /generic:"${target}" /user:"${fullUser}" /pass:"${password}"`, (err: any) => {
                    if (err) {
                        console.error("[RDP Native] cmdkey error:", err.message);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });

            // Launch mstsc.exe
            const mstscProcess = exec(`mstsc /v:${host}:${port}`, (err: any) => {
                if (err && err.code !== null) {
                    console.error("[RDP Native] mstsc error:", err.message);
                }
            });

            socket.emit("rdp-native-launched");

            // Clean up credentials after mstsc closes (or after 5 seconds as safety)
            mstscProcess.on('exit', () => {
                exec(`cmdkey /delete:"${target}"`, () => {
                    console.log("[RDP Native] Credentials cleaned up");
                });
            });

            // Safety cleanup after 10 seconds if mstsc hasn't exited
            setTimeout(() => {
                exec(`cmdkey /delete:"${target}"`, () => { });
            }, 10000);

        } catch (err: any) {
            socket.emit("rdp-error", "Failed to launch native RDP: " + err.message);
        }
    });

    socket.on("disconnect", () => {
        if (conn) conn.end();
        if (ftp) ftp.close();
        if (localTerm) { localTerm.kill(); localTerm = null; }
        try { uploadState?.sftpStream?.destroy?.(); } catch (e) { }
        try { uploadState?.pass?.destroy?.(); } catch (e) { }
        try { uploadState?.s3Upload?.abort?.(); } catch (e) { }
        uploadState = null;
        clearBitmapFlush();
        if (rdpClient) { try { rdpClient.close(); } catch (e) { } rdpClient = null; }
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
