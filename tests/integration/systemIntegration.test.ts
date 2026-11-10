import { describe, expect, it, vi } from 'vitest';
import { registerIpcRouter } from '../../src/main/ipcRouter';
import { SystemIntegration } from '../../src/main/systemIntegration';

type ShortcutListener = () => void;

interface ShortcutRegistrarLike {
    register(accelerator: string, listener: ShortcutListener): boolean;
    unregister(accelerator: string): void;
}

interface MenuItemTemplateLike {
    label?: string;
    type?: 'separator';
    click?: () => void;
}

interface TrayLike {
    setContextMenu(menu: unknown): void;
    destroy(): void;
}

interface PowerMonitorLike {
    isOnBatteryPower(): boolean;
    getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown';
    on(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery', listener: () => void): unknown;
    removeListener(
        event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
        listener: () => void
    ): unknown;
}

interface SystemIntegrationOptionsLike {
    shortcutRegistrar: ShortcutRegistrarLike;
    tray: TrayLike;
    buildMenu(template: MenuItemTemplateLike[]): unknown;
    powerMonitor: PowerMonitorLike;
    onSelectionShortcut(): void;
    onScreenshotShortcut(): void;
    onShow(): void;
    onOpenSettings(): void;
    onCheckUpdates(): void;
    onPausedChange(paused: boolean): void;
    onExit(): void;
}

interface SystemIntegrationApi {
    registerShortcuts(map: {
        selection: string;
        screenshot: string;
    }): Promise<void>;
    setSuppressionPolicy(policy: {
        reduceMotion: boolean;
        pauseWhenFullscreen: boolean;
    }): Promise<void>;
    setPresentationActive(active: boolean): void;
    togglePaused(): boolean;
    refreshSystemState(): Promise<void>;
    getPerformanceMode(): {
        reason: 'normal' | 'idle' | 'hidden' | 'battery' | 'paused' | 'fullscreen';
        frameRate: 0 | 10 | 30;
        suppressed: boolean;
    };
    dispose(): Promise<void>;
}

class FakeShortcutRegistrar implements ShortcutRegistrarLike {
    readonly listeners = new Map<string, ShortcutListener>();
    readonly failed = new Set<string>();

    register(accelerator: string, listener: ShortcutListener): boolean {
        if (this.failed.has(accelerator))
            return false;
        this.listeners.set(accelerator, listener);
        return true;
    }

    unregister(accelerator: string): void {
        this.listeners.delete(accelerator);
    }

    trigger(accelerator: string): void {
        this.listeners.get(accelerator)?.();
    }
}

class FakePowerMonitor implements PowerMonitorLike {
    batteryReads = 0;
    idleReads = 0;
    onBattery = false;
    idleState: 'active' | 'idle' | 'locked' | 'unknown' = 'active';
    readonly listeners = new Map<
        'suspend' | 'resume' | 'on-ac' | 'on-battery',
        Set<() => void>
    >();

    isOnBatteryPower(): boolean {
        ++this.batteryReads;
        return this.onBattery;
    }

    getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown' {
        expect(idleThreshold).toBeGreaterThan(0);
        ++this.idleReads;
        return this.idleState;
    }

    on(
        event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
        listener: () => void
    ): unknown {
        const listeners = this.listeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    removeListener(
        event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
        listener: () => void
    ): unknown {
        this.listeners.get(event)?.delete(listener);
        return this;
    }

    emit(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery'): void {
        for (const listener of this.listeners.get(event) ?? [])
            listener();
    }

    listenerCount(): number {
        return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
    }
}

function createHarness(overrides: Partial<SystemIntegrationOptionsLike> = {}): {
    integration: SystemIntegrationApi;
    shortcuts: FakeShortcutRegistrar;
    powerMonitor: FakePowerMonitor;
    tray: TrayLike & { menu?: unknown; destroyed: boolean };
    callbacks: Record<
        'selection' | 'screenshot' | 'show' | 'settings' | 'updates' | 'pause' | 'exit',
        ReturnType<typeof vi.fn>
    >;
} {
    const shortcuts = new FakeShortcutRegistrar();
    const powerMonitor = new FakePowerMonitor();
    const tray = {
        menu: undefined as unknown,
        destroyed: false,
        setContextMenu(menu: unknown) {
            this.menu = menu;
        },
        destroy() {
            this.destroyed = true;
        }
    };
    const callbacks = {
        selection: vi.fn(),
        screenshot: vi.fn(),
        show: vi.fn(),
        settings: vi.fn(),
        updates: vi.fn(),
        pause: vi.fn(),
        exit: vi.fn()
    };
    const Integration = SystemIntegration as unknown as new (
        options: SystemIntegrationOptionsLike
    ) => SystemIntegrationApi;
    return {
        integration: new Integration({
            shortcutRegistrar: shortcuts,
            tray,
            buildMenu: (template) => template,
            powerMonitor,
            onSelectionShortcut: callbacks.selection,
            onScreenshotShortcut: callbacks.screenshot,
            onShow: callbacks.show,
            onOpenSettings: callbacks.settings,
            onCheckUpdates: callbacks.updates,
            onPausedChange: callbacks.pause,
            onExit: callbacks.exit,
            ...overrides
        }),
        shortcuts,
        powerMonitor,
        tray,
        callbacks
    };
}

describe('SystemIntegration shortcuts', () => {
    it('registers configurable unique shortcuts and dispatches their actions', async () => {
        const harness = createHarness();

        await harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Alt+S'
        });

        expect([...harness.shortcuts.listeners.keys()]).toEqual([
            'Control+Shift+T',
            'Alt+S'
        ]);
        harness.shortcuts.trigger('Control+Shift+T');
        harness.shortcuts.trigger('Alt+S');
        expect(harness.callbacks.selection).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.screenshot).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid shortcut keys before registering anything', async () => {
        const harness = createHarness();

        await expect(harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift',
            screenshot: 'Ctrl+Alt+S'
        })).rejects.toThrow(/valid/i);
        expect(harness.shortcuts.listeners.size).toBe(0);
    });

    it('rejects conflicting shortcut keys before registering anything', async () => {
        const harness = createHarness();

        await expect(harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Control+Shift+t'
        })).rejects.toThrow(/unique|conflict/i);
        expect(harness.shortcuts.listeners.size).toBe(0);
    });

    it('normalizes modifier order and aliases before conflict checks', async () => {
        const harness = createHarness();

        await expect(harness.integration.registerShortcuts({
            selection: 'Shift+Ctrl+T',
            screenshot: 'Control+shift+t'
        })).rejects.toThrow(/unique|conflict/i);
        expect(harness.shortcuts.listeners.size).toBe(0);
    });

    it('rejects unavailable accelerators without leaking partial registrations', async () => {
        const harness = createHarness();
        harness.shortcuts.failed.add('Control+Shift+S');

        await expect(harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Ctrl+Shift+S'
        })).rejects.toThrow(/unavailable|registered/i);
        expect(harness.shortcuts.listeners.size).toBe(0);
    });

    it('restores previous shortcuts when a replacement registration conflicts', async () => {
        const harness = createHarness();
        await harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Ctrl+Shift+P'
        });
        harness.shortcuts.failed.add('Control+Alt+S');

        await expect(harness.integration.registerShortcuts({
            selection: 'Alt+S',
            screenshot: 'Ctrl+Alt+S'
        })).rejects.toThrow(/unavailable|registered/i);
        expect([...harness.shortcuts.listeners.keys()]).toEqual([
            'Control+Shift+T',
            'Control+Shift+P'
        ]);
    });
});

describe('SystemIntegration tray', () => {
    it('provides show settings pause-resume and exit actions', async () => {
        const harness = createHarness();
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: true
        });

        const menu = harness.tray.menu as MenuItemTemplateLike[];
        expect(menu.map((item) => item.label)).toEqual([
            'Show',
            'Settings',
            'Check updates',
            'Pause',
            undefined,
            'Exit'
        ]);
        menu[0].click?.();
        menu[1].click?.();
        menu[2].click?.();
        menu[3].click?.();
        expect(harness.callbacks.show).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.settings).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.updates).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.pause).toHaveBeenCalledWith(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });

        const resumedMenu = harness.tray.menu as MenuItemTemplateLike[];
        expect(resumedMenu[3].label).toBe('Resume');
        resumedMenu[3].click?.();
        expect(harness.callbacks.pause).toHaveBeenLastCalledWith(false);
        resumedMenu[5].click?.();
        expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    });
});

describe('SystemIntegration shutdown', () => {
    it('disposes shortcuts tray and power listeners idempotently', async () => {
        const harness = createHarness();
        await harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Ctrl+Shift+S'
        });
        await harness.integration.dispose();
        await harness.integration.dispose();

        expect(harness.shortcuts.listeners.size).toBe(0);
        expect(harness.tray.destroyed).toBe(true);
        expect(harness.powerMonitor.listenerCount()).toBe(0);
    });
});

describe('SystemIntegration settings transactions', () => {
    it('restores shortcut and suppression runtime state when persistence fails', async () => {
        const harness = createHarness();
        await harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Ctrl+Shift+S'
        });
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: true
        });
        const applySettings = (
            harness.integration as unknown as {
                applySettings?: (
                    preferences: {
                        hotkey: string;
                        screenshotHotkey: string;
                        performance: {
                            reduceMotion: boolean;
                            pauseWhenFullscreen: boolean;
                        };
                    },
                    persist: () => Promise<unknown>
                ) => Promise<unknown>;
            }
        ).applySettings;
        expect(applySettings).toBeTypeOf('function');

        await expect(applySettings?.call(
            harness.integration,
            {
                hotkey: 'Alt+S',
                screenshotHotkey: 'Alt+P',
                performance: {
                    reduceMotion: true,
                    pauseWhenFullscreen: false
                }
            },
            async () => {
                throw new Error('Settings persistence failed.');
            }
        )).rejects.toThrow(/persistence failed/i);
        expect([...harness.shortcuts.listeners.keys()]).toEqual([
            'Control+Shift+T',
            'Control+Shift+S'
        ]);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'normal',
            frameRate: 30,
            suppressed: false
        });
    });
});

describe('SystemIntegration IPC', () => {
    it('exposes the current performance mode and removes its handler on disposal', async () => {
        const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
        const mode = {
            reason: 'battery',
            frameRate: 10,
            suppressed: false
        } as const;
        const getPerformanceMode = vi.fn(() => mode);
        const dispose = registerIpcRouter({
            ipcMain: {
                handle: (
                    channel: string,
                    listener: (event: unknown, payload?: unknown) => unknown
                ) => handlers.set(channel, listener),
                removeHandler: (channel: string) => handlers.delete(channel)
            },
            secureConfig: {
                saveProvider: vi.fn(),
                setActiveProvider: vi.fn(),
                getProviderSummaries: vi.fn(),
                testProvider: vi.fn()
            },
            isSenderAuthorized: () => true,
            getPerformanceMode
        } as unknown as Parameters<typeof registerIpcRouter>[0]);

        const handler = handlers.get('desktop-pet:performance-get');
        expect(handler).toBeTypeOf('function');
        await expect(handler?.({}, {})).resolves.toEqual({
            ok: true,
            value: mode
        });
        expect(getPerformanceMode).toHaveBeenCalledTimes(1);
        dispose();
        expect(handlers.has('desktop-pet:performance-get')).toBe(false);
    });
});
