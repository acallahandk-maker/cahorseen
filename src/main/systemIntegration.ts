import { execFile } from 'node:child_process';
import {
    normalizeHotkey,
    type PerformanceMode,
    type SettingsPreferences,
    type SettingsState
} from '../shared/contracts';
import {
    resolvePerformanceMode,
    targetFrameRate,
    type PerformanceContext
} from './services/performanceGovernor';

export interface QuizInterruptionState {
    fullscreen: boolean;
    activeTranslation: boolean;
    intenseInput: boolean;
}

export type QuizSuppressionReason = keyof QuizInterruptionState;

export interface SuppressionPolicy {
    reduceMotion: boolean;
    pauseWhenFullscreen: boolean;
    limitFrameRate: boolean;
}

export type ShortcutAction = 'selection' | 'screenshot';
export type ShortcutMap = Record<ShortcutAction, string>;

export interface ShortcutRegistrar {
    register(accelerator: string, listener: () => void): boolean;
    unregister(accelerator: string): void;
}

export interface MenuItemTemplate {
    label?: string;
    type?: 'separator';
    click?: () => void;
}

export interface TrayLike {
    setContextMenu(menu: unknown): void;
    destroy(): void;
}

export type PowerMonitorEvent =
    | 'suspend'
    | 'resume'
    | 'on-ac'
    | 'on-battery';

export interface PowerMonitorLike {
    isOnBatteryPower(): boolean;
    getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown';
    on(event: PowerMonitorEvent, listener: () => void): unknown;
    removeListener(event: PowerMonitorEvent, listener: () => void): unknown;
}

export interface FullscreenProbe {
    read(signal: AbortSignal): Promise<{ fullscreen: boolean }>;
}

export type FullscreenProbeExecFile = (
    file: string,
    args: string[],
    options: {
        encoding: 'utf8';
        killSignal: 'SIGTERM';
        signal: AbortSignal;
        timeout: number;
        windowsHide: true;
    },
    callback: (error: Error | null, stdout: string) => void
) => FullscreenProbeChild;

export interface FullscreenProbeChild {
    kill(signal?: NodeJS.Signals | number): boolean;
    once(
        event: 'exit',
        listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): unknown;
}

export interface WindowsFullscreenProbeOptions {
    platform?: NodeJS.Platform;
    execFile?: FullscreenProbeExecFile;
}

export interface WindowBoundsSnapshot {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface FullscreenWindowSnapshot {
    windowBounds: WindowBoundsSnapshot;
    monitorBounds: WindowBoundsSnapshot;
    hasCaption: boolean;
}

export interface SystemIntegrationOptions {
    shortcutRegistrar: ShortcutRegistrar;
    tray: TrayLike;
    buildMenu(template: MenuItemTemplate[]): unknown;
    powerMonitor: PowerMonitorLike;
    fullscreenProbe: FullscreenProbe;
    onSelectionShortcut(): void;
    onScreenshotShortcut(): void;
    onShow(): void;
    onOpenSettings(): void;
    onPausedChange(paused: boolean): void;
    onExit(): void;
    onPerformanceChange?(mode: PerformanceMode): void;
    idleThresholdSeconds?: number;
    systemStatePollIntervalMs?: number;
}

export type PerformanceWindowEvent =
    | 'enter-full-screen'
    | 'leave-full-screen'
    | 'hide'
    | 'show';

export interface PerformanceWindowEvents {
    on(event: PerformanceWindowEvent, listener: () => void): unknown;
}

export interface PerformanceWindowState {
    setFullscreen(fullscreen: boolean): void;
    setHidden(hidden: boolean): void;
}

export function configurePerformanceWindowEvents(
    windowEvents: PerformanceWindowEvents,
    state: PerformanceWindowState
): void {
    windowEvents.on('enter-full-screen', () => state.setFullscreen(true));
    windowEvents.on('leave-full-screen', () => state.setFullscreen(false));
    windowEvents.on('hide', () => state.setHidden(true));
    windowEvents.on('show', () => state.setHidden(false));
}

export function shouldSuppressQuizInterruptions(
    state: QuizInterruptionState
): boolean {
    return state.fullscreen
        || state.activeTranslation
        || state.intenseInput;
}

function normalizeSettingsPolicy(
    policy: SettingsPreferences['performance'] | SuppressionPolicy
): SuppressionPolicy {
    return {
        reduceMotion: policy.reduceMotion,
        pauseWhenFullscreen: policy.pauseWhenFullscreen,
        limitFrameRate: policy.limitFrameRate
    };
}

function parseBounds(value: unknown): WindowBoundsSnapshot {
    const bounds = value as Partial<Record<keyof WindowBoundsSnapshot, unknown>>;
    if (
        typeof bounds.left !== 'number'
        || typeof bounds.top !== 'number'
        || typeof bounds.right !== 'number'
        || typeof bounds.bottom !== 'number'
        || !Number.isFinite(bounds.left)
        || !Number.isFinite(bounds.top)
        || !Number.isFinite(bounds.right)
        || !Number.isFinite(bounds.bottom)
    )
        throw new Error('Windows fullscreen bounds are invalid.');
    return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom
    };
}

function parseFullscreenSnapshot(value: unknown): FullscreenWindowSnapshot {
    const snapshot = value as Partial<Record<keyof FullscreenWindowSnapshot, unknown>>;
    if (typeof snapshot.hasCaption !== 'boolean')
        throw new Error('Windows fullscreen state is invalid.');
    return {
        windowBounds: parseBounds(snapshot.windowBounds),
        monitorBounds: parseBounds(snapshot.monitorBounds),
        hasCaption: snapshot.hasCaption
    };
}

export function isWindowsFullscreenWindow(
    snapshot: FullscreenWindowSnapshot
): boolean {
    return !snapshot.hasCaption
        && snapshot.windowBounds.left <= snapshot.monitorBounds.left
        && snapshot.windowBounds.top <= snapshot.monitorBounds.top
        && snapshot.windowBounds.right >= snapshot.monitorBounds.right
        && snapshot.windowBounds.bottom >= snapshot.monitorBounds.bottom;
}

export function createWindowsFullscreenProbe(
    options: WindowsFullscreenProbeOptions = {}
): FullscreenProbe {
    const platform = options.platform ?? process.platform;
    const runExecFile = options.execFile
        ?? execFile as unknown as FullscreenProbeExecFile;
    return {
        async read(signal: AbortSignal): Promise<{ fullscreen: boolean }> {
            if (platform !== 'win32' && options.execFile === undefined)
                return { fullscreen: false };
            const source = [
                'using System;',
                'using System.Runtime.InteropServices;',
                'public static class DesktopPetWindowProbe {',
                '  [StructLayout(LayoutKind.Sequential)]',
                '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
                '  [StructLayout(LayoutKind.Sequential)]',
                '  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }',
                '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
                '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);',
                '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);',
                '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);',
                '  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);',
                '}'
            ].join('\n');
            const script = [
                '$source = @\'',
                source,
                '\'@',
                'Add-Type -TypeDefinition $source',
                '$window = [DesktopPetWindowProbe]::GetForegroundWindow()',
                'if ($window -eq [IntPtr]::Zero) { "0"; exit }',
                '$windowRect = New-Object DesktopPetWindowProbe+RECT',
                'if (-not [DesktopPetWindowProbe]::GetWindowRect($window, [ref]$windowRect)) { "0"; exit }',
                '$monitor = [DesktopPetWindowProbe]::MonitorFromWindow($window, 2)',
                '$monitorInfo = New-Object DesktopPetWindowProbe+MONITORINFO',
                '$monitorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DesktopPetWindowProbe+MONITORINFO])',
                'if (-not [DesktopPetWindowProbe]::GetMonitorInfoW($monitor, [ref]$monitorInfo)) { "0"; exit }',
                '$style = [DesktopPetWindowProbe]::GetWindowLongPtrW($window, -16).ToInt64()',
                '[pscustomobject]@{',
                '  windowBounds = [pscustomobject]@{ left = $windowRect.Left; top = $windowRect.Top; right = $windowRect.Right; bottom = $windowRect.Bottom }',
                '  monitorBounds = [pscustomobject]@{ left = $monitorInfo.rcMonitor.Left; top = $monitorInfo.rcMonitor.Top; right = $monitorInfo.rcMonitor.Right; bottom = $monitorInfo.rcMonitor.Bottom }',
                '  hasCaption = (($style -band 0x00C00000) -ne 0)',
                '} | ConvertTo-Json -Compress'
            ].join('\n');
            return await new Promise<{ fullscreen: boolean }>((resolve, reject) => {
                let child: FullscreenProbeChild | undefined;
                let exited = false;
                let settled = false;
                const cleanup = (): void => {
                    signal.removeEventListener('abort', handleAbort);
                };
                const resolveOnce = (value: { fullscreen: boolean }): void => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    resolve(value);
                };
                const rejectOnce = (error: Error): void => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    reject(error);
                };
                const abortError = (): Error => {
                    const error = new Error('Windows fullscreen probe was aborted.');
                    error.name = 'AbortError';
                    return error;
                };
                const finishAbort = (): void => {
                    if (exited)
                        rejectOnce(abortError());
                };
                const handleExit = (): void => {
                    exited = true;
                    finishAbort();
                };
                function handleAbort(): void {
                    if (settled)
                        return;
                    if (child !== undefined && !exited) {
                        try {
                            child.kill('SIGTERM');
                        } catch (error) {
                            rejectOnce(error instanceof Error ? error : new Error(String(error)));
                            return;
                        }
                    }
                    finishAbort();
                }
                signal.addEventListener('abort', handleAbort, { once: true });
                try {
                    child = runExecFile('powershell.exe', [
                        '-NoProfile',
                        '-NonInteractive',
                        '-EncodedCommand',
                        Buffer.from(script, 'utf16le').toString('base64')
                    ], {
                        encoding: 'utf8',
                        killSignal: 'SIGTERM',
                        signal,
                        timeout: 5_000,
                        windowsHide: true
                    }, (error, stdout) => {
                        if (signal.aborted) {
                            finishAbort();
                            return;
                        }
                        if (error !== null) {
                            rejectOnce(error);
                            return;
                        }
                        try {
                            const normalized = stdout.trim();
                            if (normalized === '0') {
                                resolveOnce({ fullscreen: false });
                                return;
                            }
                            resolveOnce({
                                fullscreen: isWindowsFullscreenWindow(
                                    parseFullscreenSnapshot(JSON.parse(normalized))
                                )
                            });
                        } catch (parseError) {
                            rejectOnce(parseError instanceof Error
                                ? parseError
                                : new Error(String(parseError)));
                        }
                    });
                    if (!settled)
                        child.once('exit', handleExit);
                    if (signal.aborted)
                        handleAbort();
                } catch (error) {
                    rejectOnce(error instanceof Error ? error : new Error(String(error)));
                }
            });
        }
    };
}

interface PendingSystemRead {
    controller: AbortController;
    promise: Promise<unknown>;
}

export class SystemIntegration {
    private readonly options: SystemIntegrationOptions;
    private readonly registeredShortcuts = new Map<ShortcutAction, string>();
    private fullscreen = false;
    private activeTranslation = false;
    private intenseInput = false;
    private presentationActive = false;
    private hidden = false;
    private obscured = false;
    private paused = false;
    private suspended = false;
    private battery = false;
    private idle = false;
    private suppressionPolicy: SuppressionPolicy = {
        reduceMotion: false,
        pauseWhenFullscreen: true,
        limitFrameRate: true
    };
    private readonly pendingReads = new Set<PendingSystemRead>();
    private systemStateTimer: ReturnType<typeof setInterval> | undefined;
    private settingsTransaction: Promise<unknown> = Promise.resolve();
    private disposePromise: Promise<void> | undefined;
    private disposed = false;

    constructor(options: SystemIntegrationOptions) {
        this.options = options;
        this.options.powerMonitor.on('suspend', this.handleSuspend);
        this.options.powerMonitor.on('resume', this.handleResume);
        this.options.powerMonitor.on('on-ac', this.handleOnAc);
        this.options.powerMonitor.on('on-battery', this.handleOnBattery);
        this.updateTrayMenu();
        this.startSystemStatePolling();
    }

    getQuizInterruptionState(): QuizInterruptionState {
        return {
            fullscreen: this.fullscreen,
            activeTranslation: this.activeTranslation,
            intenseInput: this.intenseInput
                || this.presentationActive
                || this.obscured
                || this.paused
                || this.suspended
        };
    }

    getQuizSuppressionReason(): QuizSuppressionReason | undefined {
        const state = this.getQuizInterruptionState();
        if (state.fullscreen && this.suppressionPolicy.pauseWhenFullscreen)
            return 'fullscreen';
        if (state.activeTranslation)
            return 'activeTranslation';
        if (state.intenseInput)
            return 'intenseInput';
        return undefined;
    }

    setFullscreen(fullscreen: boolean): void {
        this.fullscreen = fullscreen;
        this.emitPerformanceChange();
    }

    setActiveTranslation(activeTranslation: boolean): void {
        this.activeTranslation = activeTranslation;
        this.emitPerformanceChange();
    }

    setIntenseInput(intenseInput: boolean): void {
        this.intenseInput = intenseInput;
        this.emitPerformanceChange();
    }

    setPresentationActive(active: boolean): void {
        this.presentationActive = active;
        this.emitPerformanceChange();
    }

    setHidden(hidden: boolean): void {
        this.hidden = hidden;
        this.emitPerformanceChange();
    }

    setObscured(obscured: boolean): void {
        this.obscured = obscured;
        this.emitPerformanceChange();
    }

    async setSuppressionPolicy(
        policy: SettingsPreferences['performance'] | SuppressionPolicy
    ): Promise<void> {
        this.suppressionPolicy = normalizeSettingsPolicy(policy);
        this.emitPerformanceChange();
    }

    async registerShortcuts(map: ShortcutMap): Promise<void> {
        const entries = Object.entries(map) as Array<[ShortcutAction, string]>;
        const normalized = entries.map(([action, value]) => {
            const accelerator = normalizeHotkey(value);
            if (accelerator === undefined)
                throw new Error(`Invalid ${action} shortcut.`);
            return [action, accelerator] as const;
        });
        const accelerators = normalized.map(([, accelerator]) => accelerator);
        if (new Set(accelerators).size !== accelerators.length)
            throw new Error('Shortcut keys must be unique.');

        const previousEntries = [...this.registeredShortcuts];
        this.unregisterShortcuts();
        const registered: Array<[ShortcutAction, string]> = [];
        try {
            for (const [action, accelerator] of normalized) {
                const listener = this.getShortcutListener(action);
                if (!this.options.shortcutRegistrar.register(accelerator, listener))
                    throw new Error(`Shortcut ${accelerator} is unavailable or already registered.`);
                registered.push([action, accelerator]);
                this.registeredShortcuts.set(action, accelerator);
            }
        } catch (error) {
            for (const [, accelerator] of registered)
                this.options.shortcutRegistrar.unregister(accelerator);
            this.registeredShortcuts.clear();
            for (const [action, accelerator] of previousEntries) {
                if (this.options.shortcutRegistrar.register(
                    accelerator,
                    this.getShortcutListener(action)
                ))
                    this.registeredShortcuts.set(action, accelerator);
            }
            throw error;
        }
    }

    applySettings(
        preferences: SettingsPreferences,
        persist: (preferences: SettingsPreferences) => Promise<SettingsState>
    ): Promise<SettingsState> {
        const operation = this.settingsTransaction.then(
            () => this.applySettingsNow(preferences, persist)
        );
        this.settingsTransaction = operation.catch(() => undefined);
        return operation;
    }

    togglePaused(): boolean {
        this.paused = !this.paused;
        this.options.onPausedChange(this.paused);
        this.updateTrayMenu();
        this.emitPerformanceChange();
        return this.paused;
    }

    async refreshSystemState(): Promise<void> {
        if (this.disposed)
            return;
        for (const pendingRead of this.pendingReads)
            pendingRead.controller.abort();
        const controller = new AbortController();
        let readPromise: Promise<{ fullscreen: boolean }>;
        try {
            readPromise = this.options.fullscreenProbe.read(controller.signal);
        } catch (error) {
            readPromise = Promise.reject(error);
        }
        const pendingRead: PendingSystemRead = {
            controller,
            promise: readPromise
        };
        this.pendingReads.add(pendingRead);
        this.battery = this.options.powerMonitor.isOnBatteryPower();
        const idleState = this.options.powerMonitor.getSystemIdleState(
            this.options.idleThresholdSeconds ?? 60
        );
        this.idle = idleState === 'idle' || idleState === 'locked';
        try {
            const state = await readPromise;
            if (controller.signal.aborted || this.disposed)
                return;
            this.fullscreen = state.fullscreen;
            this.setPresentationActive(state.fullscreen);
        } catch {
            if (controller.signal.aborted || this.disposed)
                return;
            this.fullscreen = true;
            this.setPresentationActive(true);
        } finally {
            this.pendingReads.delete(pendingRead);
        }
    }

    getPerformanceMode(): PerformanceMode {
        const context: PerformanceContext = {
            paused: this.paused
                || this.suspended
                || (this.presentationActive && !this.fullscreen)
                || this.suppressionPolicy.reduceMotion,
            hidden: this.hidden,
            obscured: this.obscured,
            battery: this.battery,
            idle: this.idle,
            fullscreen: this.fullscreen || this.presentationActive,
            suppressed: this.activeTranslation
        };
        const mode = resolvePerformanceMode(context);
        return {
            ...mode,
            frameRate: targetFrameRate(context)
        };
    }

    canStartQuiz(): boolean {
        return !this.getQuizSuppressionReason();
    }

    canAnswerQuiz(): boolean {
        return this.canStartQuiz();
    }

    dispose(): Promise<void> {
        if (this.disposePromise !== undefined)
            return this.disposePromise;
        this.disposed = true;
        this.stopSystemStatePolling();
        const pendingReads = [...this.pendingReads];
        for (const pendingRead of pendingReads)
            pendingRead.controller.abort();
        this.disposePromise = (async () => {
            await Promise.allSettled(pendingReads.map((pendingRead) => pendingRead.promise));
            this.unregisterShortcuts();
            this.options.powerMonitor.removeListener('suspend', this.handleSuspend);
            this.options.powerMonitor.removeListener('resume', this.handleResume);
            this.options.powerMonitor.removeListener('on-ac', this.handleOnAc);
            this.options.powerMonitor.removeListener('on-battery', this.handleOnBattery);
            this.options.tray.destroy();
        })();
        return this.disposePromise;
    }

    private readonly handleSuspend = (): void => {
        this.suspended = true;
        this.stopSystemStatePolling();
        for (const pendingRead of this.pendingReads)
            pendingRead.controller.abort();
        this.emitPerformanceChange();
    };

    private readonly handleResume = (): void => {
        this.suspended = false;
        this.startSystemStatePolling();
        void this.refreshSystemState();
    };

    private readonly handleOnAc = (): void => {
        this.setBatteryState(false);
    };

    private readonly handleOnBattery = (): void => {
        this.setBatteryState(true);
    };

    private setBatteryState(battery: boolean): void {
        if (this.disposed || this.battery === battery)
            return;
        this.battery = battery;
        this.emitPerformanceChange();
    }

    private startSystemStatePolling(): void {
        if (
            this.disposed
            || this.suspended
            || this.systemStateTimer !== undefined
        )
            return;
        const interval = this.options.systemStatePollIntervalMs ?? 30_000;
        if (interval <= 0)
            return;
        this.systemStateTimer = setInterval(() => {
            void this.refreshSystemState();
        }, interval);
    }

    private stopSystemStatePolling(): void {
        if (this.systemStateTimer === undefined)
            return;
        clearInterval(this.systemStateTimer);
        this.systemStateTimer = undefined;
    }

    private async applySettingsNow(
        preferences: SettingsPreferences,
        persist: (preferences: SettingsPreferences) => Promise<SettingsState>
    ): Promise<SettingsState> {
        const previousShortcuts = [...this.registeredShortcuts];
        const previousPolicy = { ...this.suppressionPolicy };
        try {
            await this.registerShortcuts({
                selection: preferences.hotkey,
                screenshot: preferences.screenshotHotkey
            });
            await this.setSuppressionPolicy(preferences.performance);
            return await persist(preferences);
        } catch (error) {
            const rollbackErrors: unknown[] = [];
            try {
                await this.setSuppressionPolicy(previousPolicy);
                this.restoreShortcutEntries(previousShortcuts);
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    'Settings application failed and rollback was incomplete.',
                    { cause: error }
                );
            }
            throw error;
        }
    }

    private restoreShortcutEntries(
        entries: Array<[ShortcutAction, string]>
    ): void {
        this.unregisterShortcuts();
        for (const [action, accelerator] of entries) {
            if (this.options.shortcutRegistrar.register(
                accelerator,
                this.getShortcutListener(action)
            ))
                this.registeredShortcuts.set(action, accelerator);
            else
                throw new Error(`Unable to restore shortcut ${accelerator}.`);
        }
    }

    private unregisterShortcuts(): void {
        for (const accelerator of this.registeredShortcuts.values())
            this.options.shortcutRegistrar.unregister(accelerator);
        this.registeredShortcuts.clear();
    }

    private getShortcutListener(action: ShortcutAction): () => void {
        return action === 'selection'
            ? this.options.onSelectionShortcut
            : this.options.onScreenshotShortcut;
    }

    private updateTrayMenu(): void {
        this.options.tray.setContextMenu(this.options.buildMenu([
            {
                label: 'Show',
                click: () => this.options.onShow()
            },
            {
                label: 'Settings',
                click: () => this.options.onOpenSettings()
            },
            {
                label: this.paused ? 'Resume' : 'Pause',
                click: () => this.togglePaused()
            },
            { type: 'separator' },
            {
                label: 'Exit',
                click: () => this.options.onExit()
            }
        ]));
    }

    private emitPerformanceChange(): void {
        if (!this.disposed)
            this.options.onPerformanceChange?.(this.getPerformanceMode());
    }
}
