import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell, type MessageBoxOptions, type RenderProcessGoneDetails } from 'electron';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { startBackend, type Backend } from './backend';
import { DATABASE_FILE, DataKeyError, DataKeySession } from './dataKey';
import { APP_USER_MODEL_ID, devUserDataDir } from './identity';
import { redactLogText, RotatingLogFile } from './logFile';
import { RestartBudget } from './restartBudget';
import { DEFAULT_TITLE_BAR, TITLE_BAR_HEIGHT, loadTitleBar, saveTitleBar, titleBarFor, type TitleBarColors } from './titleBar';
import { externalUrl, isAppUrl } from './urls';

// Packaged: forks the bundled backend on a free loopback port with a fresh
// session token, waits for it to report ready, then loads the UI with
// ?api=&token= (the renderer keeps them and strips the URL). Development
// (`npm run electron:dev`): scripts/dev.mjs runs the backend and Vite; this
// process only opens the Vite URL.

const isDev = !app.isPackaged;
const DEV_URL = process.env.SHELLMIND_DEV_URL?.trim() || 'http://localhost:5173';
const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');
const SERVER_ENTRY = path.join(__dirname, '..', 'dist-server', 'server.js');
const APP_URL = isDev ? DEV_URL : pathToFileURL(INDEX_HTML).href;

// Before anything reads userData or takes the single-instance lock.
if (isDev) app.setPath('userData', devUserDataDir(app.getPath('appData')));
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

const READY_TIMEOUT_MS = 30_000;
// More crashes than this within the window stop the automatic restarts (of
// the backend, of the window's renderer).
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

// Web permissions the UI needs: the terminal and the chat copy and paste
// through the async clipboard API, the fleet board raises desktop
// notifications (W7-S1; only when its setting is on), and the embedded Remote
// Desktop goes full screen and, there, locks the keyboard so Win, Alt+Tab and
// Escape reach the remote desktop (W7-S6). Everything else is denied.
const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen', 'keyboardLock']);

const STRINGS = {
    en: {
        starting: 'Starting ShellMind…',
        failed: 'The ShellMind backend could not start.',
        crashed: 'The ShellMind backend stopped unexpectedly.',
        uiFailed: 'The ShellMind window could not be loaded.',
        uiCrashed: 'The ShellMind window stopped working.',
        keyUnreadable: 'ShellMind cannot read the key that protects your saved credentials.',
        keyMissing: 'The key that protects your saved credentials is missing.',
        keyHelp: (file: string) => 'The key is tied to this user account on this computer (the OS keychain): a data folder copied from another computer or account cannot use it. '
            + `To keep your saved passwords, private keys and API keys, restore the original ${file} and choose Retry. `
            + 'Or start over: they are cleared and must be entered again. Your servers and everything else stay.',
        confirmStartOver: 'Clear the saved credentials and start over with a new key?',
        confirmStartOverDetail: 'Saved passwords, private keys, passphrases and API keys are cleared. The old key file is kept next to the new one as a backup.',
        logFile: 'Log file',
        retry: 'Retry',
        startOver: 'Start over',
        cancel: 'Cancel',
        quit: 'Quit'
    },
    es: {
        starting: 'Iniciando ShellMind…',
        failed: 'No se pudo iniciar el backend de ShellMind.',
        crashed: 'El backend de ShellMind se ha detenido inesperadamente.',
        uiFailed: 'No se pudo cargar la ventana de ShellMind.',
        uiCrashed: 'La ventana de ShellMind ha dejado de funcionar.',
        keyUnreadable: 'ShellMind no puede leer la clave que protege tus credenciales guardadas.',
        keyMissing: 'Falta la clave que protege tus credenciales guardadas.',
        keyHelp: (file: string) => 'La clave está ligada a esta cuenta de usuario en este equipo (el llavero del sistema): una carpeta de datos copiada de otro equipo o de otra cuenta no puede usarla. '
            + `Para conservar tus contraseñas, claves privadas y claves de API guardadas, restaura el archivo original ${file} y elige Reintentar. `
            + 'O empieza de nuevo: se borran y tendrás que introducirlas otra vez. Tus servidores y todo lo demás se conservan.',
        confirmStartOver: '¿Borrar las credenciales guardadas y empezar de nuevo con una clave nueva?',
        confirmStartOverDetail: 'Se borran las contraseñas, claves privadas, frases de contraseña y claves de API guardadas. El archivo de la clave anterior se conserva junto al nuevo como copia de seguridad.',
        logFile: 'Archivo de registro',
        retry: 'Reintentar',
        startOver: 'Empezar de nuevo',
        cancel: 'Cancelar',
        quit: 'Salir'
    }
};

let mainWindow: BrowserWindow | null = null;
let backend: Backend | null = null;
let launched: { port: number; token: string } | null = null;
let dataKey: DataKeySession;
let quitting = false;
const backendRestarts = new RestartBudget(MAX_RESTARTS, RESTART_WINDOW_MS);
const rendererRestarts = new RestartBudget(MAX_RESTARTS, RESTART_WINDOW_MS);
let log: RotatingLogFile;

const text = () => (app.getLocale().toLowerCase().startsWith('es') ? STRINGS.es : STRINGS.en);

function logLine(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    const line = redactLogText(`${new Date().toISOString()} ${level} [main] ${message}`);
    if (level === 'INFO') console.log(line);
    else console.error(line);
    log?.write(`${line}\n`);
}

function openExternal(url: string) {
    const safe = externalUrl(url);
    if (safe) void shell.openExternal(safe);
    else logLine('WARN', `Blocked opening ${JSON.stringify(url.slice(0, 200))}`);
}

function installSecurityPolicy() {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));

    app.on('web-contents-created', (_event, contents) => {
        // New windows never open inside the app; safe links go to the OS browser.
        contents.setWindowOpenHandler(({ url }) => {
            openExternal(url);
            return { action: 'deny' };
        });
        // The window must never leave the app (a clicked link, a dropped file):
        // that would put an arbitrary page in the frameless app chrome.
        contents.on('will-navigate', (event) => {
            if (isAppUrl(event.url, APP_URL)) return;
            event.preventDefault();
            openExternal(event.url);
        });
        contents.on('will-redirect', (event) => {
            if (!isAppUrl(event.url, APP_URL)) event.preventDefault();
        });
        contents.on('will-attach-webview', (event) => event.preventDefault());
    });
}

function installMenu() {
    // On macOS, an application menu with Edit roles is required for Cmd+C/V/X to
    // work inside inputs. On Windows/Linux, Chromium handles clipboard shortcuts
    // natively and a Copy accelerator would otherwise steal Ctrl+C (SIGINT) from
    // the terminal — so we only install the menu on macOS.
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
        return;
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
    ]));
}

function iconPath() {
    const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    return app.isPackaged
        ? path.join(process.resourcesPath, 'build', file)
        : path.join(__dirname, '..', 'build', file);
}

// The title bar colours of the last session: the window, the splash and the
// overlay start in the theme the UI is about to show.
const titleBarFile = () => path.join(app.getPath('userData'), 'window-theme.json');
let titleBar: TitleBarColors = DEFAULT_TITLE_BAR;

function createWindow(): BrowserWindow {
    titleBar = loadTitleBar(titleBarFile());
    const window = new BrowserWindow({
        width: 1280,
        height: 800,
        // Sidebar, workspace and chat side by side need this much room.
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: titleBar.background,
        icon: iconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        },
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        // Matches the app's 40 px title bar; recoloured with the theme below.
        titleBarOverlay: { color: titleBar.color, symbolColor: titleBar.symbolColor, height: TITLE_BAR_HEIGHT }
    });
    window.on('closed', () => {
        if (mainWindow === window) mainWindow = null;
    });
    // A renderer that crashed (GPU/WebGL, out of memory) leaves the window
    // blank: load the UI again.
    window.webContents.on('render-process-gone', (_event, details) => void rendererGone(window, details));
    window.on('unresponsive', () => logLine('WARN', 'The window stopped responding'));
    window.on('responsive', () => logLine('INFO', 'The window responds again'));
    // The page's theme-color is its title bar colour (light or dark theme).
    // macOS draws its own traffic lights: only the background follows there.
    window.webContents.on('did-change-theme-color', (_event, color) => {
        const next = titleBarFor(color);
        if (!next || window.isDestroyed()) return;
        if (process.platform !== 'darwin') window.setTitleBarOverlay({ color: next.color, symbolColor: next.symbolColor, height: TITLE_BAR_HEIGHT });
        // What shows while resizing, before the page repaints: its background.
        window.setBackgroundColor(next.background);
        if (next.color !== titleBar.color) saveTitleBar(titleBarFile(), next);
        titleBar = next;
    });
    return window;
}

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function showSplash(window: BrowserWindow) {
    const html = `<!doctype html><meta charset="utf-8"><title>ShellMind</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:${titleBar.color};color:${titleBar.symbolColor};font:14px system-ui,sans-serif"><span style="opacity:.7">${text().starting}</span></body>`;
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}

function loadUi(window: BrowserWindow) {
    if (isDev) {
        window.loadURL(DEV_URL).catch((error: unknown) => void uiLoadFailed(window, error));
        return;
    }
    if (!launched) {
        showSplash(window);
        return;
    }
    window.loadFile(INDEX_HTML, {
        query: { api: `http://127.0.0.1:${launched.port}`, token: launched.token }
    }).catch((error: unknown) => void uiLoadFailed(window, error));
}

// Electron's message for a failed load repeats the URL, which carries the
// session token: only the error code is logged and shown.
async function uiLoadFailed(window: BrowserWindow, error: unknown) {
    const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
    // Superseded by a newer load (a reload while the backend restarts).
    if (code === 'ERR_ABORTED') return;
    const reason = typeof code === 'string'
        ? `${code}${typeof errno === 'number' ? ` (${errno})` : ''}`
        : redactLogText(error instanceof Error ? error.message : String(error));
    logLine('ERROR', `Could not load the UI: ${reason}`);
    if (quitting || window.isDestroyed()) return;
    if (await askToRetry(text().uiFailed, reason)) {
        if (!window.isDestroyed()) loadUi(window);
    } else {
        app.quit();
    }
}

async function rendererGone(window: BrowserWindow, details: RenderProcessGoneDetails) {
    if (details.reason === 'clean-exit') return;
    logLine('ERROR', `The window's renderer is gone: ${details.reason} (exit code ${details.exitCode})`);
    if (quitting || window.isDestroyed()) return;
    if (rendererRestarts.take() || await askToRetry(text().uiCrashed, details.reason)) {
        if (!window.isDestroyed()) loadUi(window);
    } else {
        app.quit();
    }
}

function showMessage(options: MessageBoxOptions) {
    return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

async function askToRetry(message: string, reason: string): Promise<boolean> {
    const strings = text();
    const { response } = await showMessage({
        type: 'error',
        title: 'ShellMind',
        message,
        detail: `${reason}\n\n${strings.logFile}: ${log.filePath}`,
        buttons: [strings.retry, strings.quit],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    });
    return response === 0;
}

// The data key cannot be used: unreadable (another computer or user
// account, a reset keychain) or missing for a database that holds encrypted
// credentials. Retry, start over with a new key (after a confirmation), or quit.
async function askAboutDataKey(error: unknown, reason: string): Promise<'retry' | 'start-over' | 'quit'> {
    const strings = text();
    for (;;) {
        const { response } = await showMessage({
            type: 'error',
            title: 'ShellMind',
            message: error instanceof DataKeyError ? strings.keyUnreadable : strings.keyMissing,
            // The backend's own refusal speaks of key files and environment
            // variables of a self-hosted install: it stays in the log.
            detail: `${error instanceof DataKeyError ? `${reason}\n\n` : ''}${strings.keyHelp(dataKey.keyFile)}\n\n${strings.logFile}: ${log.filePath}`,
            buttons: [strings.retry, strings.startOver, strings.quit],
            defaultId: 0,
            cancelId: 2,
            noLink: true
        });
        if (response !== 1) return response === 0 ? 'retry' : 'quit';
        const confirmed = await showMessage({
            type: 'warning',
            title: 'ShellMind',
            message: strings.confirmStartOver,
            detail: strings.confirmStartOverDetail,
            buttons: [strings.startOver, strings.cancel],
            defaultId: 1,
            cancelId: 1,
            noLink: true
        });
        if (confirmed.response === 0) return 'start-over';
    }
}

// PORT 0: the OS picks a free port and the backend reports it in its "ready"
// message, so no other process can grab it in between.
let keychainChecked = false;

async function backendEnv(token: string): Promise<NodeJS.ProcessEnv> {
    const keyEnv = await dataKey.backendEnv();
    if (!keychainChecked) {
        keychainChecked = true;
        if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
            logLine('WARN', 'No OS keychain found: the credentials key is only obfuscated (safeStorage basic_text).');
        }
    }
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        SHELLMIND_AUTH_TOKEN: token,
        SHELLMIND_VERSION: app.getVersion(),
        DB_PATH: path.join(app.getPath('userData'), DATABASE_FILE),
        // The desktop backend only ever serves this window, a file:// page.
        SHELLMIND_ALLOW_FILE_ORIGIN: '1',
        ALLOWED_HOSTS: '',
        ALLOWED_ORIGINS: '',
        SERVE_WEB: ''
    };
    // Unset ones stay unset, whatever this process inherited.
    for (const [name, value] of Object.entries(keyEnv)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
    }
    return env;
}

// Starts the backend (fresh port, the current token or a new one) and loads
// the UI against it. On failure the user chooses between Retry and Quit.
async function launchBackend(token: string, failureMessage: string): Promise<void> {
    for (;;) {
        try {
            if (!fs.existsSync(SERVER_ENTRY)) throw new Error(`Bundled backend not found: ${SERVER_ENTRY}`);
            logLine('INFO', 'Starting the backend');
            const started = await startBackend({
                entry: SERVER_ENTRY,
                env: await backendEnv(token),
                // .env lookups (dotenv) stay inside the app's own data folder.
                cwd: app.getPath('userData'),
                readyTimeoutMs: READY_TIMEOUT_MS,
                onOutput: (output) => log.write(redactLogText(output))
            });
            if (quitting) {
                // The user quit while it was starting.
                await started.stop();
                return;
            }
            backend = started;
            launched = { port: started.port, token };
            logLine('INFO', `Backend ready on 127.0.0.1:${started.port}`);
            await dataKey.started();
            superviseBackend(started);
            if (mainWindow) loadUi(mainWindow);
            return;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            logLine('ERROR', `Backend start failed: ${reason}`);
            if (quitting) return;
            if (dataKey.isKeyFailure(error)) {
                const choice = await askAboutDataKey(error, reason);
                if (choice === 'quit') {
                    app.quit();
                    return;
                }
                if (choice === 'start-over') {
                    const backups = dataKey.startOver();
                    logLine('WARN', `Starting over with a new data key; the saved credentials are cleared${backups.length ? ` (old key kept as ${backups.join(', ')})` : ''}`);
                } else {
                    dataKey.retry();
                }
            } else if (!(await askToRetry(failureMessage, reason))) {
                app.quit();
                return;
            }
            token = randomBytes(32).toString('base64url');
        }
    }
}

// A backend that dies on its own is restarted and the UI reloaded against it;
// repeated crashes go to the Retry/Quit dialog instead.
function superviseBackend(current: Backend) {
    void current.exited.then(async ({ code, signal, reason, expected }) => {
        if (backend === current) backend = null;
        if (expected || quitting) return;

        const detail = reason ?? (signal ? `signal ${signal}` : `exit code ${code}`);
        logLine('ERROR', `Backend stopped unexpectedly (${detail})`);

        if (!backendRestarts.take() && !(await askToRetry(text().crashed, detail))) {
            app.quit();
            return;
        }
        await launchBackend(launched?.token ?? randomBytes(32).toString('base64url'), text().failed);
    });
}

async function boot() {
    log = new RotatingLogFile(path.join(app.getPath('userData'), 'server.log'));
    dataKey = new DataKeySession(app.getPath('userData'), safeStorage, (message) => logLine('WARN', message));
    installSecurityPolicy();
    installMenu();
    // The GPU process and other helpers: the window survives them, the log
    // explains a blank or slow one.
    app.on('child-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit') logLine('WARN', `The ${details.type} process is gone: ${details.reason} (exit code ${details.exitCode})`);
    });

    mainWindow = createWindow();
    loadUi(mainWindow);

    if (isDev) {
        mainWindow.webContents.openDevTools();
        return;
    }
    await launchBackend(randomBytes(32).toString('base64url'), text().failed);
}

if (!app.requestSingleInstanceLock()) {
    // Another instance owns the data folder and its backend: hand over to it.
    app.quit();
} else {
    app.on('second-instance', focusMainWindow);

    app.whenReady().then(boot).catch((error) => {
        logLine('ERROR', `Startup failed: ${error instanceof Error ? error.stack : String(error)}`);
        dialog.showErrorBox('ShellMind', `${text().failed}\n\n${error instanceof Error ? error.message : String(error)}`);
        app.quit();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length > 0) return;
        mainWindow = createWindow();
        loadUi(mainWindow);
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    // Give the backend a chance to close its sessions cleanly before exiting.
    app.on('before-quit', (event) => {
        quitting = true;
        if (!backend) {
            log?.close();
            return;
        }
        event.preventDefault();
        const stopping = backend;
        backend = null;
        void stopping.stop().finally(() => app.quit());
    });
}
