import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { runSmokeModeIfEnabled } from './smokeMode';

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
