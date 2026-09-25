const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let serverPort = 4321;
let isQuitting = false;

// Ensure single instance lock so double-clicking shortcut doesn't create multiple servers
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

function checkServerReady(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/system`, { timeout: 1500 }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 500) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  while (await checkPortInUse(port)) {
    // Check if it's already our deepfake degradation server running on this port
    const isOurServer = await checkServerReady(port);
    if (isOurServer) {
      console.log(`Found existing server instance running on port ${port}`);
      return { port, isExisting: true };
    }
    port++;
  }
  return { port, isExisting: false };
}

function startNextServer(port) {
  return new Promise((resolve, reject) => {
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged && process.argv.includes('--dev');
    const nextBin = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'bin', 'next');
    const projectRoot = path.join(__dirname, '..');
    const args = [nextBin, isDev ? 'dev' : 'start', '-p', String(port)];

    console.log(`Starting Next.js server on port ${port} (mode: ${isDev ? 'dev' : 'production'})...`);

    // On Windows, use cmd or direct node
    const nodeExecutable = process.execPath;
    const env = Object.assign({}, process.env, {
      PORT: String(port),
      NODE_ENV: isDev ? 'development' : 'production',
      ELECTRON_RUN_AS_NODE: '1',
      IS_DESKTOP: '1',
      DESKTOP_APP: 'true'
    });

    // Try starting with electron as node or fallback to node
    try {
      serverProcess = spawn(nodeExecutable, args, {
        cwd: projectRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      serverProcess = spawn('node', args, {
        cwd: projectRoot,
        env: Object.assign({}, process.env, {
          PORT: String(port),
          IS_DESKTOP: '1',
          DESKTOP_APP: 'true'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    serverProcess.stdout.on('data', (chunk) => {
      const msg = chunk.toString();
      console.log(`[Next.js Server] ${msg.trim()}`);
    });

    serverProcess.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      console.error(`[Next.js Error] ${msg.trim()}`);
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to spawn Next.js server:', err);
      reject(err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`Next.js server exited with code ${code}, signal ${signal}`);
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          'Server Terminated',
          'The background video degradation server stopped unexpectedly. Please restart the application.'
        );
      }
    });

    resolve();
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    console.log('Stopping background Next.js server...');
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${serverProcess.pid} /T /F 2>nul`, { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) {
      try {
        serverProcess.kill('SIGKILL');
      } catch (err) { }
    }
    serverProcess = null;
  }
}

async function waitForServer(port, maxWaitMs = 45000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const ready = await checkServerReady(port);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function createMainWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: 'DeepFake Bulk Video Degradation Tool',
    icon: iconPath,
    backgroundColor: '#0a0b0e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Handle opening external links in the default browser rather than inside the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Load splash screen first
  const splashPath = path.join(__dirname, 'splash.html');
  mainWindow.loadFile(splashPath);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createMainWindow();

  try {
    const { port, isExisting } = await findAvailablePort(4321);
    serverPort = port;

    if (!isExisting) {
      await startNextServer(serverPort);
    }

    const ready = await waitForServer(serverPort);
    if (!ready) {
      throw new Error(`Server failed to respond on http://127.0.0.1:${serverPort} within 45 seconds.`);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    }
  } catch (err) {
    console.error('Startup error:', err);
    dialog.showErrorBox('Startup Error', `Failed to start desktop app:\n${err.message}`);
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('will-quit', () => {
  stopServer();
});

app.on('window-all-closed', () => {
  isQuitting = true;
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('exit', () => stopServer());
process.on('SIGINT', () => {
  stopServer();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopServer();
  process.exit(0);
});
