import { describe, expect, it, vi } from 'vitest';
import {
    createWindowsFullscreenProbe,
    isWindowsFullscreenWindow,
    SystemIntegration
} from '../../src/main/systemIntegration';

type PerformanceModeLike = {
    reason: 'normal' | 'idle' | 'hidden' | 'battery' | 'paused' | 'fullscreen';
    frameRate: 0 | 10 | 30;
    suppressed: boolean;
};

interface SystemIntegrationApi {
    setSuppressionPolicy(policy: {
        reduceMotion: boolean;
        pauseWhenFullscreen: boolean;
        limitFrameRate: boolean;
    }): Promise<void>;
    setFullscreen(fullscreen: boolean): void;
    setActiveTranslation(active: boolean): void;
    setIntenseInput(intenseInput: boolean): void;
    setPresentationActive(active: boolean): void;
    setHidden(hidden: boolean): void;
    setObscured(obscured: boolean): void;
    refreshSystemState(): Promise<void>;
    getPerformanceMode(): PerformanceModeLike;
    getQuizSuppressionReason(): 'fullscreen' | 'activeTranslation' | 'intenseInput' | undefined;
    canStartQuiz(): boolean;
    canAnswerQuiz(): boolean;
    dispose(): Promise<void>;
}

function createIntegration(options: { systemStatePollIntervalMs?: number } = {}): {
    integration: SystemIntegrationApi;
    powerMonitor: {
        onBattery: boolean;
        idleState: 'active' | 'idle' | 'locked' | 'unknown';
        batteryReads: number;
        idleReads: number;
        listeners: Map<
            'suspend' | 'resume' | 'on-ac' | 'on-battery',
            Set<() => void>
        >;
        emit(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery'): void;
    };
    probe: {
        calls: number;
        fullscreen: boolean;
        pending: boolean;
        aborts: number;
        read(signal: AbortSignal): Promise<{ fullscreen: boolean }>;
    };
} {
    const powerMonitor = {
        onBattery: false,
        idleState: 'active' as 'active' | 'idle' | 'locked' | 'unknown',
        batteryReads: 0,
        idleReads: 0,
        listeners: new Map<
            'suspend' | 'resume' | 'on-ac' | 'on-battery',
            Set<() => void>
        >(),
        isOnBatteryPower() {
            ++this.batteryReads;
            return this.onBattery;
        },
        getSystemIdleState() {
            ++this.idleReads;
            return this.idleState;
        },
        on(
            event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
            listener: () => void
        ) {
            const listeners = this.listeners.get(event) ?? new Set<() => void>();
            listeners.add(listener);
            this.listeners.set(event, listeners);
            return this;
        },
        removeListener(
            event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
            listener: () => void
        ) {
            this.listeners.get(event)?.delete(listener);
            return this;
        },
        emit(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery') {
            for (const listener of this.listeners.get(event) ?? [])
                listener();
        }
    };
    const probe = {
        calls: 0,
        fullscreen: false,
        pending: false,
        aborts: 0,
        async read(signal: AbortSignal): Promise<{ fullscreen: boolean }> {
            ++this.calls;
            this.pending = true;
            signal.addEventListener('abort', () => ++this.aborts, { once: true });
            await Promise.resolve();
            this.pending = false;
            return { fullscreen: this.fullscreen };
        }
    };
    const tray = {
        setContextMenu: vi.fn(),
        destroy: vi.fn()
    };
    const shortcutRegistrar = {
        register: vi.fn(() => true),
        unregister: vi.fn()
    };
    const Integration = SystemIntegration as unknown as new (options: unknown) => SystemIntegrationApi;
    return {
        integration: new Integration({
            shortcutRegistrar,
            tray,
            buildMenu: (template: unknown) => template,
            powerMonitor,
            fullscreenProbe: probe,
            onShow: vi.fn(),
            onOpenSettings: vi.fn(),
            onPausedChange: vi.fn(),
            onExit: vi.fn(),
            ...options
        }),
        powerMonitor,
        probe
    };
}

describe('performance suppression', () => {
    it('pauses animation when the shared policy requests reduced motion', async () => {
        const harness = createIntegration();

        await harness.integration.setSuppressionPolicy({
            reduceMotion: true,
            pauseWhenFullscreen: true,
            limitFrameRate: true
        });

        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
    });

    it('uses deterministic performance modes for presentation fullscreen battery and normal states', async () => {
        const harness = createIntegration();
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: true,
            limitFrameRate: true
        });

        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'normal',
            frameRate: 30,
            suppressed: false
        });
        harness.integration.setPresentationActive(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
        harness.integration.setPresentationActive(false);
        harness.integration.setFullscreen(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'fullscreen',
            frameRate: 0,
            suppressed: true
        });
        harness.integration.setFullscreen(false);
        harness.powerMonitor.onBattery = true;
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'battery',
            frameRate: 10,
            suppressed: false
        });
    });

    it('shares fullscreen translation and presentation suppression with quiz scheduling', () => {
        const harness = createIntegration();

        harness.integration.setFullscreen(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('fullscreen');
        expect(harness.integration.canStartQuiz()).toBe(false);
        expect(harness.integration.canAnswerQuiz()).toBe(false);
        harness.integration.setFullscreen(false);
        harness.integration.setActiveTranslation(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('activeTranslation');
        harness.integration.setActiveTranslation(false);
        harness.integration.setPresentationActive(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('intenseInput');
        harness.integration.setPresentationActive(false);
        harness.integration.setObscured(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('intenseInput');
        expect(harness.integration.canStartQuiz()).toBe(false);
        expect(harness.integration.canAnswerQuiz()).toBe(false);
    });

    it('derives presentation suppression from production fullscreen probes', async () => {
        const harness = createIntegration();
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: false,
            limitFrameRate: true
        });
        harness.probe.fullscreen = true;

        await harness.integration.refreshSystemState();

        expect(harness.integration.getQuizSuppressionReason()).toBe('intenseInput');
    });

    it('does not infer obscured state from ordinary window blur', async () => {
        const systemModule = await import('../../src/main/systemIntegration') as unknown as
            Record<string, unknown>;
        expect(systemModule.configurePerformanceWindowEvents).toBeTypeOf('function');
        const listeners = new Map<string, () => void>();
        const setObscured = vi.fn();
        const configure = systemModule.configurePerformanceWindowEvents as (
            windowEvents: {
                on(event: string, listener: () => void): unknown;
            },
            state: {
                setFullscreen(fullscreen: boolean): void;
                setHidden(hidden: boolean): void;
                setObscured(obscured: boolean): void;
            }
        ) => void;
        configure({
            on(event, listener) {
                listeners.set(event, listener);
            }
        }, {
            setFullscreen: vi.fn(),
            setHidden: vi.fn(),
            setObscured
        });

        listeners.get('blur')?.();
        listeners.get('focus')?.();
        expect(setObscured).not.toHaveBeenCalled();
    });

    it('reduces hidden idle obscured and battery rendering to the required frame rates', async () => {
        const harness = createIntegration();
        harness.integration.setHidden(true);
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'hidden',
            frameRate: 10
        });
        harness.integration.setHidden(false);
        harness.integration.setObscured(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
        harness.integration.setObscured(false);
        harness.powerMonitor.idleState = 'idle';
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'idle',
            frameRate: 10
        });
        harness.powerMonitor.onBattery = true;
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'battery',
            frameRate: 10
        });
    });
});

describe('system reads and power lifecycle', () => {
    it('reads battery idle and Windows fullscreen state once per explicit refresh', async () => {
        const harness = createIntegration();

        await harness.integration.refreshSystemState();
        harness.integration.getPerformanceMode();
        harness.integration.getPerformanceMode();

        expect(harness.powerMonitor.batteryReads).toBe(1);
        expect(harness.powerMonitor.idleReads).toBe(1);
        expect(harness.probe.calls).toBe(1);
    });

    it('aborts pending reads on suspend and performs one fresh read on resume', async () => {
        const harness = createIntegration();
        harness.probe.pending = true;
        const refresh = harness.integration.refreshSystemState();

        harness.powerMonitor.emit('suspend');
        expect(harness.probe.aborts).toBe(1);
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'paused',
            frameRate: 0
        });

        harness.powerMonitor.emit('resume');
        await refresh;
        await Promise.resolve();
        expect(harness.probe.calls).toBe(2);
        expect(harness.powerMonitor.batteryReads).toBe(2);
        expect(harness.powerMonitor.idleReads).toBe(2);
    });

    it('applies battery and AC transitions from powerMonitor events', async () => {
        const harness = createIntegration();

        harness.powerMonitor.emit('on-battery');
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'battery',
            frameRate: 10
        });
        harness.powerMonitor.emit('on-ac');
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'normal',
            frameRate: 30
        });
    });

    it('polls bounded one-shot state so idle and external fullscreen changes apply', async () => {
        vi.useFakeTimers();
        try {
            const harness = createIntegration({
                systemStatePollIntervalMs: 25
            });
            harness.powerMonitor.idleState = 'idle';

            await vi.advanceTimersByTimeAsync(25);

            expect(harness.powerMonitor.idleReads).toBeGreaterThan(0);
            expect(harness.probe.calls).toBeGreaterThan(0);
            expect(harness.integration.getPerformanceMode()).toMatchObject({
                reason: 'idle',
                frameRate: 10
            });

            harness.powerMonitor.idleState = 'active';
            harness.probe.fullscreen = true;
            await vi.advanceTimersByTimeAsync(25);

            expect(harness.integration.getPerformanceMode()).toMatchObject({
                reason: 'fullscreen',
                frameRate: 0
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Windows fullscreen detection', () => {
    it('only treats an uncaptioned foreground window covering its monitor as fullscreen', () => {
        const monitorBounds = {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080
        };

        expect(isWindowsFullscreenWindow({
            windowBounds: monitorBounds,
            monitorBounds,
            hasCaption: false
        })).toBe(true);
        expect(isWindowsFullscreenWindow({
            windowBounds: monitorBounds,
            monitorBounds,
            hasCaption: true
        })).toBe(false);
        expect(isWindowsFullscreenWindow({
            windowBounds: {
                left: 10,
                top: 10,
                right: 1910,
                bottom: 1070
            },
            monitorBounds,
            hasCaption: false
        })).toBe(false);
    });

    it('performs one short-lived native foreground-window read per probe', async () => {
        const calls: Array<{ file: string; signal: AbortSignal }> = [];
        const child = {
            killed: false,
            kill: vi.fn(() => true),
            once: vi.fn()
        };
        const probe = createWindowsFullscreenProbe({
            platform: 'linux',
            execFile: (file, _args, options, callback) => {
                calls.push({ file, signal: options.signal });
                callback(null, JSON.stringify({
                    windowBounds: {
                        left: 0,
                        top: 0,
                        right: 1920,
                        bottom: 1080
                    },
                    monitorBounds: {
                        left: 0,
                        top: 0,
                        right: 1920,
                        bottom: 1080
                    },
                    hasCaption: false
                }));
                return child as never;
            }
        });
        const controller = new AbortController();

        await expect(probe.read(controller.signal)).resolves.toEqual({
            fullscreen: true
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].file).toBe('powershell.exe');
        expect(calls[0].signal).toBe(controller.signal);
    });

    it('kills and joins a spawned fullscreen probe during disposal', async () => {
        let exitListener: (() => void) | undefined;
        let killRequested = false;
        let exited = false;
        let callback: ((error: Error | null, stdout: string) => void) | undefined;
        const Integration = SystemIntegration as unknown as new (options: unknown) => SystemIntegrationApi;
        const integration = new Integration({
            shortcutRegistrar: {
                register: () => true,
                unregister: () => undefined
            },
            tray: {
                setContextMenu: () => undefined,
                destroy: () => undefined
            },
            buildMenu: (template: unknown) => template,
            powerMonitor: {
                isOnBatteryPower: () => false,
                getSystemIdleState: () => 'active',
                on: () => undefined,
                removeListener: () => undefined
            },
            fullscreenProbe: createWindowsFullscreenProbe({
                platform: 'linux',
                execFile: (_file, _args, options, callbackArg) => {
                    callback = callbackArg;
                    const child = {
                        kill: () => {
                            killRequested = true;
                            exitListener?.();
                            return true;
                        },
                        once: (event: string, listener: () => void) => {
                            if (event === 'exit')
                                exitListener = () => {
                                    exited = true;
                                    listener();
                                };
                            return child;
                        }
                    };
                    options.signal.addEventListener('abort', () => {
                        setTimeout(() => {
                            if (!killRequested) {
                                exited = true;
                                callback?.(new Error('aborted'), '');
                            }
                        }, 0);
                    }, { once: true });
                    return child as never;
                }
            }),
            onSelectionShortcut: () => undefined,
            onScreenshotShortcut: () => undefined,
            onShow: () => undefined,
            onOpenSettings: () => undefined,
            onPausedChange: () => undefined,
            onExit: () => undefined
        });
        const refresh = integration.refreshSystemState();

        const disposal = integration.dispose();
        await disposal;
        await refresh;

        expect(killRequested).toBe(true);
        expect(exited).toBe(true);
    });

    it('falls back to suppression when the fullscreen probe fails', async () => {
        const harness = createIntegration();
        harness.probe.read = async () => {
            throw new Error('Fullscreen probe failed.');
        };

        await harness.integration.refreshSystemState();

        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'fullscreen',
            frameRate: 0,
            suppressed: true
        });
    });
});
