import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fork, ChildProcess } from 'child_process';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
    titleBarStyle: 'hidden', // For a modern look if we want custom title bar later
    titleBarOverlay: {
        color: '#18181b', // Zinc-950
        symbolColor: '#e4e4e7', // Zinc-200
        height: 30
    }
  });

  // Open links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
  });

  if (isDev) {
    // In development, load from Vite dev server
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load from built files
    // The structure will be:
    // app/
    //   dist/index.html
    //   dist-electron/main.js
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    // DEBUG: Enable DevTools in production for troubleshooting
    // mainWindow.webContents.openDevTools();
  }
}

// Start the Express Backend
function startServer() {
    if (isDev) {
        console.log('In Dev mode, assuming server is running separately via npm run server');
        return;
    }

    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'shellmind.db');
    console.log('Setting DB_PATH for bundled server:', dbPath);

    // Set the env var for the child process
    const env = { ...process.env, DB_PATH: dbPath, PORT: '3001' };

    // Path to the compiled server file
    // We will compile server_clean.ts to dist-server/server_clean.js
    const serverPath = path.join(__dirname, '../dist-server/server_clean.js');

    console.log('Starting server from:', serverPath);
    
    const logPath = path.join(userDataPath, 'server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    console.log('Server logs at:', logPath);

    serverProcess = fork(serverPath, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    serverProcess.stdout?.pipe(logStream);
    serverProcess.stderr?.pipe(logStream);

    serverProcess.stdout?.on('data', (data) => {
        console.log(`[Server Output]: ${data}`);
    });

    serverProcess.stderr?.on('data', (data) => {
        console.error(`[Server Error]: ${data}`);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Server process exited with code ${code}`);
        if (code !== 0 && code !== null) {
             fs.appendFileSync(logPath, `[FATAL] Server exited with code ${code}\n`);
        }
    });
}

app.whenReady().then(() => {
    startServer();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
});
