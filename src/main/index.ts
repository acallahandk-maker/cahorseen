import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import {
    getProductionRendererFileUrl,
    isProductionRendererUrl,
    registerIpcRouter
} from './ipcRouter';
import {
    ScreenshotOverlayController,
    type ScreenshotOverlayWindowLike,
    type ScreenshotOverlayWindowOptions
} from './screenshotOverlay';
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
    screenshotSelectionSchema,
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

function getScreenshotOverlayUrl(): string {
    const url = new URL(
        process.env.ELECTRON_RENDERER_URL ?? getProductionRendererFileUrl()
    );
    url.searchParams.set('screenshot-overlay', '1');
    return url.href;
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
    let petWindow = createWindow();
    if (runSmokeModeIfEnabled(petWindow))
        return;
    const screenshotOverlay = new ScreenshotOverlayController({
        ipcMain,
        overlayUrl: getScreenshotOverlayUrl(),
        getDisplays: () => screen.getAllDisplays().map((display) => display.bounds),
        createWindow: (
            options: ScreenshotOverlayWindowOptions
        ): ScreenshotOverlayWindowLike => new BrowserWindow({
            ...options,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                preload: join(__dirname, '../preload/index.js'),
                sandbox: true
            }
        }),
        onSelected: (bounds, owner) => {
            owner.send(
                screenshotIpcChannels.selected,
                screenshotSelectionSchema.parse({ bounds })
            );
        },
        isSenderAuthorized: (event, channel) => {
            const senderFrame = (
                event as { senderFrame?: { url?: unknown } }
            ).senderFrame;
            return channel === screenshotIpcChannels.open
                ? isProductionRendererUrl(senderFrame?.url)
                : senderFrame?.url === getScreenshotOverlayUrl();
        }
    });
    const disposeSelectionShortcut = registerSelectionShortcut({
        shortcut: globalShortcut,
        onTrigger: () => {
            if (!petWindow.isDestroyed())
                petWindow.webContents.send(translationIpcChannels.selectionShortcut);
        }
    });
    const disposeScreenshotShortcut = registerScreenshotShortcut({
        shortcut: globalShortcut,
        onTrigger: () => {
            if (!petWindow.isDestroyed()) {
                void screenshotOverlay.open(petWindow.webContents).catch(
                    () => undefined
                );
            }
        }
    });
    app.on('will-quit', () => {
        disposeSelectionShortcut();
        disposeScreenshotShortcut();
        screenshotOverlay.dispose();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            petWindow = createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
