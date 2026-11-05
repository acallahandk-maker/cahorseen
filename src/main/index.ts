import {
    app,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    Menu,
    nativeImage,
    powerMonitor,
    screen,
    Tray,
    type MenuItemConstructorOptions,
    type NativeImage
} from 'electron';
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
import { runSmokeModeIfEnabled } from './smokeMode';
import {
    DEFAULT_SETTINGS_PREFERENCES,
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
    performanceIpcChannels,
    performanceModeSchema,
    screenshotSelectionSchema,
    screenshotIpcChannels,
    translationIpcChannels
} from '../shared/contracts';
import {
    closeDefaultMemoryDatabase,
    deleteEntries,
    exportEntries,
    getMemoryEnabled,
    listEntries,
    queryHeat,
    setMemoryEnabled,
    updateEntry,
    updateQuizSchedule
} from './services/memoryDatabase';
import { QuizScheduler } from './services/quizScheduler';
import {
    createWindowsFullscreenProbe,
    SystemIntegration,
    type TrayLike
} from './systemIntegration';

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

function setPixel(
    buffer: Buffer,
    width: number,
    x: number,
    y: number,
    color: readonly [number, number, number, number]
): void {
    if (x < 0 || y < 0 || x >= width || y >= width)
        return;
    const offset = (y * width + x) * 4;
    buffer[offset] = color[0];
    buffer[offset + 1] = color[1];
    buffer[offset + 2] = color[2];
    buffer[offset + 3] = color[3];
}

function createTrayIcon(): NativeImage {
    const width = 16;
    const bitmap = Buffer.alloc(width * width * 4);
    for (let y = 0; y < width; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const bodyX = (x - 8) / 6;
            const bodyY = (y - 8) / 5;
            const inBody = bodyX * bodyX + bodyY * bodyY <= 1;
            const inTail = x <= 5 && Math.abs(y - 8) <= 5 - x;
            if (inBody || inTail)
                setPixel(bitmap, width, x, y, [32, 170, 190, 255]);
        }
    }
    setPixel(bitmap, width, 11, 7, [255, 255, 255, 255]);
    setPixel(bitmap, width, 12, 7, [20, 40, 50, 255]);
    return nativeImage.createFromBitmap(bitmap, {
        width,
        height: width,
        scaleFactor: 1
    });
}

app.whenReady().then(async () => {
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
    const tray = new Tray(createTrayIcon());
    let applyQuizPause: (paused: boolean) => void = () => undefined;
    const systemIntegration = new SystemIntegration({
        shortcutRegistrar: globalShortcut,
        tray: tray as TrayLike,
        buildMenu: (template) => Menu.buildFromTemplate(
            template as MenuItemConstructorOptions[]
        ),
        powerMonitor,
        fullscreenProbe: createWindowsFullscreenProbe(),
        onSelectionShortcut: () => {
            void systemIntegration.refreshSystemState();
            if (!petWindow.isDestroyed())
                petWindow.webContents.send(translationIpcChannels.selectionShortcut);
        },
        onScreenshotShortcut: () => {
            void systemIntegration.refreshSystemState();
            if (!petWindow.isDestroyed()) {
                void screenshotOverlay.open(petWindow.webContents).catch(
                    () => undefined
                );
            }
        },
        onShow: () => {
            if (petWindow.isDestroyed()) {
                petWindow = createWindow();
                configurePetWindow(petWindow);
            }
            petWindow.show();
            petWindow.focus();
        },
        onOpenSettings: openSettingsWindow,
        onPausedChange: (paused) => {
            applyQuizPause(paused);
        },
        onExit: () => app.quit(),
        onPerformanceChange: (mode) => {
            if (!petWindow.isDestroyed()) {
                petWindow.webContents.send(
                    performanceIpcChannels.changed,
                    performanceModeSchema.parse(mode)
                );
            }
        }
    });
    const configurePetWindow = (window: BrowserWindow): void => {
        window.on('enter-full-screen', () => systemIntegration.setFullscreen(true));
        window.on('leave-full-screen', () => systemIntegration.setFullscreen(false));
        window.on('hide', () => systemIntegration.setHidden(true));
        window.on('show', () => systemIntegration.setHidden(false));
        window.on('blur', () => systemIntegration.setObscured(true));
        window.on('focus', () => systemIntegration.setObscured(false));
    };
    configurePetWindow(petWindow);
    const quizScheduler = new QuizScheduler({
        repository: {
            listEntries,
            updateQuizSchedule
        },
        canStartQuiz: () => systemIntegration.canStartQuiz(),
        canAnswerQuiz: () => systemIntegration.canAnswerQuiz()
    });
    applyQuizPause = (paused) => {
        void quizScheduler.setQuizPreferences({ paused }).catch(() => undefined);
    };
    const disposeIpcRouter = registerIpcRouter({
        ipcMain,
        secureConfig: {
            deleteProvider,
            getSettings,
            getActiveProviderConfig,
            getProviderDetails,
            saveProvider,
            saveSettings: async (preferences) => {
                await systemIntegration.registerShortcuts({
                    selection: preferences.hotkey,
                    screenshot: preferences.screenshotHotkey
                });
                await systemIntegration.setSuppressionPolicy(preferences.performance);
                return saveSettings(preferences);
            },
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
        memory: {
            queryHeat,
            listEntries,
            getMemoryEnabled,
            updateEntry,
            deleteEntries,
            exportEntries,
            setMemoryEnabled
        },
        quiz: quizScheduler,
        getPerformanceMode: () => systemIntegration.getPerformanceMode(),
        onActiveTranslationChange: (active) => {
            systemIntegration.setActiveTranslation(active);
        },
        isSenderAuthorized: (event) => {
            const senderFrame = (
                event as { senderFrame?: { url?: unknown } }
            ).senderFrame;
            return senderFrame?.url === getRendererUrl()
                || senderFrame?.url === getSettingsRendererUrl();
        },
        openSettings: openSettingsWindow
    });
    const settings = await getSettings().catch(() => ({
        preferences: DEFAULT_SETTINGS_PREFERENCES
    }));
    await systemIntegration.setSuppressionPolicy(settings.preferences.performance);
    try {
        await systemIntegration.registerShortcuts({
            selection: settings.preferences.hotkey,
            screenshot: settings.preferences.screenshotHotkey
        });
    } catch {
        openSettingsWindow();
    }
    void systemIntegration.refreshSystemState();

    let shutdownComplete = false;
    app.on('before-quit', (event) => {
        if (shutdownComplete)
            return;
        event.preventDefault();
        systemIntegration.dispose();
        disposeIpcRouter();
        screenshotOverlay.dispose();
        void closeDefaultMemoryDatabase()
            .catch(() => undefined)
            .finally(() => {
                shutdownComplete = true;
                app.quit();
            });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            petWindow = createWindow();
            configurePetWindow(petWindow);
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
