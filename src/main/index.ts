import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, dialog, nativeImage, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { Paths } from './core/paths';
import { registerIpc } from './ipc';
import { SessionManager } from './core/launcher';
import { flushStore, getSettings, saveSettings, onStoreChanged } from './core/store';
import { lockState } from './core/accounts';
import { log } from './core/log';
import * as trash from './core/trash';

/**
 * The main process.
 *
 * One window, one session registry, one tray icon, and a hard rule: the renderer never touches
 * the file system, never spawns anything, and never sees a proxy password. Everything it wants
 * goes through the preload bridge.
 *
 * The tray is not decoration. Closing the window of an anti-detect browser must not close the
 * profiles the user has open - they are separate processes doing work - so the window hides and
 * the tray keeps a way back in. That is what the original did with its NotifyIcon, and it is the
 * one behaviour users notice within a minute of using the app.
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set when the user really means to quit, so the close handler stops hiding the window. */
let quitting = false;

const sessions = new SessionManager({
  onToast: (message, detail, nativeOnly) => {
    if (!nativeOnly && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toast', { kind: 'warn', message, detail });
    }
    if (tray) {
      // A proxy watch that fires while the window is hidden has to be visible from the tray.
      tray.setToolTip(`Joe Browser - ${message}`);
    }
    // The tooltip is not enough: it only shows when the pointer is already on the tray icon.
    // A native notification is what the original's balloon alerts were for - a rotation, a proxy
    // that stopped answering, a proxy that came back - and it is the only one of the three that
    // reaches a user who is looking at another window.
    // The original showed a balloon for every toast, not only the ones raised in the
    // background, so the alert survives a window that is hidden or covered.
    if (Notification.isSupported()) {
      try {
        const notice = new Notification({ title: message, body: detail || '', silent: false });
        notice.on('click', () => {
          if (!mainWindow) return;
          mainWindow.show();
          mainWindow.focus();
        });
        notice.show();
      } catch (error) {
        log.error('cannot show a notification', error);
      }
    }
  },
});

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * The tray icon, embedded into the bundle at build time by scripts/build-main.mjs.
 *
 * It used to be read from `build/icon.png` on disk. In a packaged app that path is inside the
 * asar, `files:` did not ship it, and `new Tray(nativeImage.createEmpty())` throws - so the
 * release built, launched, and quietly had no tray icon. The constant below cannot be missing:
 * if the PNG is absent at build time the build fails.
 *
 * The source is 1024 px and a tray wants 16 to 18, so it is resized down once here.
 */
declare const __TRAY_ICON__: string;

function trayIcon(): Electron.NativeImage {
  try {
    const embedded = typeof __TRAY_ICON__ === 'string' ? __TRAY_ICON__ : '';
    const image = embedded
      ? nativeImage.createFromDataURL(embedded)
      : nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
    if (image.isEmpty()) return nativeImage.createEmpty();
    return image.resize({ width: 18, height: 18 });
  } catch (error) {
    log.error('the tray icon could not be decoded', error);
    return nativeImage.createEmpty();
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
  } catch (error) {
    log.error('the tray icon could not be created', error);
    return;
  }

  const refresh = () => {
    if (!tray) return;
    const running = sessions.list();
    const menu = Menu.buildFromTemplate([
      { label: 'Open Joe Browser', click: showWindow },
      { type: 'separator' },
      {
        label: running.length === 0 ? 'No profiles open' : `${running.length} profile${running.length === 1 ? '' : 's'} open`,
        enabled: false,
      },
      ...running.slice(0, 8).map((info) => ({
        label: `  ${info.profileName}`,
        click: () => {
          showWindow();
          broadcast('tray:focus', { profileId: info.profileId });
        },
      })),
      { type: 'separator' },
      {
        label: 'Close all profiles',
        enabled: running.length > 0,
        click: () => {
          void sessions.stopAll().then(refresh).catch((error) => log.error('Could not close all profiles', error));
        },
      },
      {
        label: 'Empty the recycle bin',
        click: () => {
          trash.emptyTrash();
          broadcast('app:changed', { profiles: getSettings().sortBy, running: 0 });
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray!.setContextMenu(menu);
    tray!.setToolTip(
      running.length > 0 ? `Joe Browser - ${running.length} profile${running.length === 1 ? '' : 's'} open` : 'Joe Browser',
    );
  };

  refresh();
  sessions.events.on('changed', refresh);
  sessions.events.on('closed', refresh);
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
}

function createWindow(): void {
  const settings = getSettings();

  mainWindow = new BrowserWindow({
    width: settings.winWidth || 1320,
    height: settings.winHeight || 860,
    minWidth: 480,
    minHeight: 540,
    show: false,
    icon: nativeImage.createFromDataURL(__TRAY_ICON__),
    backgroundColor: settings.theme === 'light' ? '#f6f7fa' : '#0e1014',
    // The window frame is drawn by the app: the title bar carries the page breadcrumb and the
    // running counter, which is a fact about the whole app rather than about one page.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: settings.theme === 'light' ? '#f6f7fa' : '#0e1014',
      symbolColor: settings.theme === 'light' ? '#414d61' : '#b9c1ce',
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses nothing but electron's own modules, so it runs sandboxed.
      sandbox: true,
      spellcheck: false,
      // The app is its own thing: nothing in the interface loads a remote frame.
      webSecurity: true,
    },
  });

  if (settings.winMaximized || settings.startMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (!settings.winMaximized && !settings.startMaximized) return;
  });

  const remember = () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getNormalBounds();
    saveSettings({
      winWidth: bounds.width,
      winHeight: bounds.height,
      winMaximized: mainWindow.isMaximized(),
    });
  };
  mainWindow.on('resize', remember);
  mainWindow.on('maximize', remember);
  mainWindow.on('unmaximize', remember);

  // A link inside the app must never replace the app's own window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['JOE_DEV_SERVER'];
    if (devServer && url.startsWith(devServer)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('https://')) void shell.openExternal(url);
  });

  // Closing the window only hides it: the profiles it launched are still open.
  mainWindow.on('close', (event) => {
    if (quitting) {
      remember();
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // The idle lock is armed once the window exists, and re-armed whenever the settings change.
  armIdleLock(mainWindow);

  const devServer = process.env['JOE_DEV_SERVER'];
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** Window controls the custom title bar needs. */
ipcMain.handle('win:minimize', () => mainWindow?.minimize());
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('win:close', () => mainWindow?.close());

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.joebrowser.app');
  Paths.ensure(Paths.root, Paths.profiles, Paths.kernels, Paths.logs, Paths.extensions, Paths.history, Paths.trash);
  nativeTheme.themeSource = getSettings().theme;

  if (!Paths.writable()) {
    log.error(`the data folder is not writable: ${Paths.root}`);
  }

  log.info(`Joe Browser ${app.getVersion()} starting in ${Paths.portable ? 'portable' : 'roaming'} mode`);
  log.info(`data folder: ${Paths.root}`);

  registerIpc({ sessions, broadcast });

  onStoreChanged(() => {
    broadcast('settings:changed', getSettings());
    if (mainWindow) armIdleLock(mainWindow);
  });

  createWindow();
  buildTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// A second launch focuses the window that is already open rather than starting a second store
// over the top of the first one.
/**
 * The idle lock.
 *
 * `autoLockMinutes` is a promise to the user - "lock after 15 minutes" - and a promise made in a
 * settings pane that nothing reads is the kind of detail that makes an app feel unfinished. The
 * window is locked, not the process: the renderer keeps its state, and the lock screen is drawn
 * over it, which is what the PIN was for in the first place.
 */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleLock(window: BrowserWindow): void {
  const minutes = getSettings().autoLockMinutes;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  // Ask the account, not a settings flag: the flag was never written, so this returned early
  // even for a user who had a PIN and an auto-lock interval configured.
  if (!minutes || minutes <= 0) return;
  const lock = lockState(getSettings());
  if (!lock.pin && !lock.totp) return;

  const reset = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Ask the renderer to show its lock screen. It re-reads the state, so a session that was
      // signed out in the meantime does not get locked behind an account that is gone.
      window.webContents.send('lock:idle');
    }, minutes * 60_000);
  };

  // Only pointer and key events count as activity; a background repaint does not.
  for (const event of ['before-input-event'] as const) {
    window.webContents.on(event, reset);
  }
  reset();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

app.on('window-all-closed', () => {
  // Nothing happens on Windows by design: the tray keeps the app alive so the profiles it
  // launched stay attached to their manager.
  if (process.platform === 'darwin') {
    /* macOS keeps the app in the dock */
  }
});

// Browsers are children of this process; quitting without closing them leaves orphaned windows
// the user has to find in Task Manager.
let stoppingForQuit = false;
app.on('before-quit', (event) => {
  if (stoppingForQuit || sessions.list().length > 0) {
    event.preventDefault();
    if (stoppingForQuit) return;
    stoppingForQuit = true;
    void sessions.stopAll().then(() => {
      stoppingForQuit = false;
      app.quit();
    }).catch((error) => {
      stoppingForQuit = false;
      quitting = false;
      log.error('Could not close browser profiles before quitting', error);
      dialog.showErrorBox('Could not quit Joe Browser', 'Close the remaining browser windows and try again.');
    });
    return;
  }
  quitting = true;
  flushStore();
});

app.on('will-quit', () => {
  flushStore();
});

process.on('uncaughtException', (error) => {
  log.error('uncaught exception in the main process', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection in the main process', reason);
});
