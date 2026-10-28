import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { join } from 'node:path';
import { registerIpcRouter } from './ipcRouter';
import {
    captureSelectionOnce,
    translateSelection
} from './services/selectionService';
import { translateScreenshot } from './services/screenshotService';
import {
    registerScreenshotShortcut,
    registerSelectionShortcut
} from './selectionShortcut';
import { runSmokeModeIfEnabled } from './smokeMode';
import {
    getProviderSummaries,
    saveProvider,
    setActiveProvider,
    testProvider
} from './services/secureConfig';
import {
    screenshotIpcChannels,
    translationIpcChannels
} from '../shared/contracts';

const pingChannel = 'desktop-pet:ping';

function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 960,
        height: 640,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(__dirname, '../preload/index.js'),
            sandbox: true
        }
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl)
        void window.loadURL(rendererUrl);
    else
        void window.loadFile(join(__dirname, '../renderer/index.html'));

    return window;
}

app.whenReady().then(() => {
    ipcMain.handle(pingChannel, () => ({ version: app.getVersion() }));
    registerIpcRouter({
        ipcMain,
        secureConfig: {
            saveProvider,
            setActiveProvider,
            getProviderSummaries,
            testProvider
        },
        selection: {
            captureSelectionOnce,
            translateSelection
        },
        screenshot: {
            translateScreenshot
        }
    });
    const disposeSelectionShortcut = registerSelectionShortcut({
        shortcut: globalShortcut,
        onTrigger: () => {
            for (const window of BrowserWindow.getAllWindows())
                window.webContents.send(translationIpcChannels.selectionShortcut);
        }
    });
    app.on('will-quit', disposeSelectionShortcut);
    const disposeScreenshotShortcut = registerScreenshotShortcut({
        shortcut: globalShortcut,
        onTrigger: () => {
            for (const window of BrowserWindow.getAllWindows())
                window.webContents.send(screenshotIpcChannels.shortcut);
        }
    });
    app.on('will-quit', disposeScreenshotShortcut);
    const window = createWindow();
    if (runSmokeModeIfEnabled(window))
        return;

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
