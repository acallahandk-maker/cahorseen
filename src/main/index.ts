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
    getActiveProviderConfig,
    getProviderSummaries,
    getProviderDetails,
    deleteProvider,
    getSettings,
    saveProvider,
    saveSettings,
    setActiveProvider,
    testProvider
} from './services/secureConfig';
import {
    screenshotSelectionSchema,
    screenshotIpcChannels,
    translationIpcChannels
} from '../shared/contracts';

const pingChannel = 'desktop-pet:ping';

function getRendererUrl(): string {
    const url = new URL(
        process.env.ELECTRON_RENDERER_URL ?? getProductionRendererFileUrl()
    );
    if (process.env.DESKTOP_PET_SMOKE_SCENARIO === 'live2d-real')
        url.searchParams.set('live2d-smoke', '1');
    return url.href;
}

function getSettingsRendererUrl(): string {
    const url = new URL(getRendererUrl());
    url.searchParams.set('settings', '1');
    return url.href;
}

function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 960,
        height: 640,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        frame: false,
        fullscreenable: false,
        hasShadow: false,
        resizable: false,
        skipTaskbar: true,
        transparent: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(__dirname, '../preload/index.js'),
            sandbox: true
        }
    });

    void window.loadURL(getRendererUrl());

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
    let petWindow = createWindow();
    let settingsWindow: BrowserWindow | undefined;
    const openSettingsWindow = (): void => {
        if (settingsWindow !== undefined && !settingsWindow.isDestroyed()) {
            settingsWindow.show();
            settingsWindow.focus();
            return;
        }
        settingsWindow = new BrowserWindow({
            parent: petWindow,
            modal: false,
            width: 680,
            height: 760,
            minWidth: 560,
            minHeight: 520,
            title: 'Desktop Pet Translator Settings',
            show: false,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                preload: join(__dirname, '../preload/index.js'),
                sandbox: true
            }
        });
        settingsWindow.once('ready-to-show', () => settingsWindow?.show());
        settingsWindow.on('closed', () => {
            settingsWindow = undefined;
        });
        void settingsWindow.loadURL(getSettingsRendererUrl());
    };
    registerIpcRouter({
        ipcMain,
        secureConfig: {
            deleteProvider,
            getSettings,
            getActiveProviderConfig,
            getProviderDetails,
            saveProvider,
            saveSettings,
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
        },
        isSenderAuthorized: (event) => {
            const senderFrame = (
                event as { senderFrame?: { url?: unknown } }
            ).senderFrame;
            return senderFrame?.url === getRendererUrl()
                || senderFrame?.url === getSettingsRendererUrl();
        },
        openSettings: () => {
            openSettingsWindow();
        }
    });
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
