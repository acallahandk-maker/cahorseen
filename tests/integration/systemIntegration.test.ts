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
    on(event: 'suspend' | 'resume', listener: () => void): unknown;
    removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

interface FullscreenProbeLike {
    read(signal: AbortSignal): Promise<{ fullscreen: boolean }>;
}

interface SystemIntegrationOptionsLike {
    shortcutRegistrar: ShortcutRegistrarLike;
    tray: TrayLike;
    buildMenu(template: MenuItemTemplateLike[]): unknown;
    powerMonitor: PowerMonitorLike;
    fullscreenProbe: FullscreenProbeLike;
    onSelectionShortcut(): void;
    onScreenshotShortcut(): void;
    onShow(): void;
    onOpenSettings(): void;
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
        limitFrameRate: boolean;
    }): Promise<void>;
    setPresentationActive(active: boolean): void;
    togglePaused(): boolean;
    refreshSystemState(): Promise<void>;
    getPerformanceMode(): {
        reason: 'normal' | 'idle' | 'hidden' | 'battery' | 'paused' | 'fullscreen';
        frameRate: 0 | 10 | 30;
        suppressed: boolean;
    };
    dispose(): void;
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
    readonly listeners = new Map<'suspend' | 'resume', Set<() => void>>();

    isOnBatteryPower(): boolean {
        ++this.batteryReads;
        return this.onBattery;
    }

    getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown' {
        expect(idleThreshold).toBeGreaterThan(0);
        ++this.idleReads;
        return this.idleState;
    }

    on(event: 'suspend' | 'resume', listener: () => void): unknown {
        const listeners = this.listeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    removeListener(event: 'suspend' | 'resume', listener: () => void): unknown {
        this.listeners.get(event)?.delete(listener);
        return this;
    }

    emit(event: 'suspend' | 'resume'): void {
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
    probe: FullscreenProbeLike & { calls: number; aborts: number };
    callbacks: Record<
        'selection' | 'screenshot' | 'show' | 'settings' | 'pause' | 'exit',
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
    const probe = {
        calls: 0,
        aborts: 0,
        async read(signal: AbortSignal): Promise<{ fullscreen: boolean }> {
            ++this.calls;
            signal.addEventListener('abort', () => ++this.aborts, { once: true });
            return { fullscreen: false };
        }
    };
    const callbacks = {
        selection: vi.fn(),
        screenshot: vi.fn(),
        show: vi.fn(),
        settings: vi.fn(),
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
            fullscreenProbe: probe,
            onSelectionShortcut: callbacks.selection,
            onScreenshotShortcut: callbacks.screenshot,
            onShow: callbacks.show,
            onOpenSettings: callbacks.settings,
            onPausedChange: callbacks.pause,
            onExit: callbacks.exit,
            ...overrides
        }),
        shortcuts,
        powerMonitor,
        tray,
        probe,
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
            pauseWhenFullscreen: true,
            limitFrameRate: true
        });

        const menu = harness.tray.menu as MenuItemTemplateLike[];
        expect(menu.map((item) => item.label)).toEqual([
            'Show',
            'Settings',
            'Pause',
            undefined,
            'Exit'
        ]);
        menu[0].click?.();
        menu[1].click?.();
        menu[2].click?.();
        expect(harness.callbacks.show).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.settings).toHaveBeenCalledTimes(1);
        expect(harness.callbacks.pause).toHaveBeenCalledWith(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });

        const resumedMenu = harness.tray.menu as MenuItemTemplateLike[];
        expect(resumedMenu[2].label).toBe('Resume');
        resumedMenu[2].click?.();
        expect(harness.callbacks.pause).toHaveBeenLastCalledWith(false);
        resumedMenu[4].click?.();
        expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    });
});

describe('SystemIntegration shutdown', () => {
    it('disposes shortcuts tray power listeners and pending one-shot reads idempotently', async () => {
        const harness = createHarness();
        await harness.integration.registerShortcuts({
            selection: 'Ctrl+Shift+T',
            screenshot: 'Ctrl+Shift+S'
        });
        const refresh = harness.integration.refreshSystemState();

        harness.integration.dispose();
        harness.integration.dispose();
        await refresh;

        expect(harness.shortcuts.listeners.size).toBe(0);
        expect(harness.tray.destroyed).toBe(true);
        expect(harness.powerMonitor.listenerCount()).toBe(0);
        expect(harness.probe.aborts).toBe(1);
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
