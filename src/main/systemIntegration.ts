import { execFile } from 'node:child_process';
import {
    isValidHotkey,
    type PerformanceMode,
    type SettingsPreferences
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

export interface PowerMonitorLike {
    isOnBatteryPower(): boolean;
    getSystemIdleState(idleThreshold: number): 'active' | 'idle' | 'locked' | 'unknown';
    on(event: 'suspend' | 'resume', listener: () => void): unknown;
    removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export interface FullscreenProbe {
    read(signal: AbortSignal): Promise<{ fullscreen: boolean }>;
}

export type FullscreenProbeExecFile = (
    file: string,
    args: string[],
    options: {
        encoding: 'utf8';
        signal: AbortSignal;
        windowsHide: true;
    },
    callback: (error: Error | null, stdout: string) => void
) => void;

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
}

export function shouldSuppressQuizInterruptions(
    state: QuizInterruptionState
): boolean {
    return state.fullscreen
        || state.activeTranslation
        || state.intenseInput;
}

function normalizeAccelerator(value: string): string {
    return value
        .split('+')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const lower = part.toLowerCase();
            if (lower === 'ctrl' || lower === 'control')
                return 'Control';
            if (lower === 'meta' || lower === 'os' || lower === 'super')
                return 'Super';
            if (lower === 'alt' || lower === 'shift') {
                const first = part[0];
                return first === undefined
                    ? part
                    : first.toUpperCase() + part.slice(1).toLowerCase();
            }
            return part.length === 1 ? part.toUpperCase() : part;
        })
        .join('+');
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
                runExecFile('powershell.exe', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-EncodedCommand',
                    Buffer.from(script, 'utf16le').toString('base64')
                ], {
                    encoding: 'utf8',
                    signal,
                    windowsHide: true
                }, (error, stdout) => {
                    if (error !== null) {
                        reject(error);
                        return;
                    }
                    try {
                        const normalized = stdout.trim();
                        if (normalized === '0') {
                            resolve({ fullscreen: false });
                            return;
                        }
                        resolve({
                            fullscreen: isWindowsFullscreenWindow(
                                parseFullscreenSnapshot(JSON.parse(normalized))
                            )
                        });
                    } catch (parseError) {
                        reject(parseError);
                    }
                });
            });
        }
    };
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
    private pendingRead: AbortController | undefined;
    private disposed = false;

    constructor(options: SystemIntegrationOptions) {
        this.options = options;
        this.options.powerMonitor.on('suspend', this.handleSuspend);
        this.options.powerMonitor.on('resume', this.handleResume);
        this.updateTrayMenu();
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
            const accelerator = normalizeAccelerator(value);
            if (!isValidHotkey(value))
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
        this.pendingRead?.abort();
        const controller = new AbortController();
        this.pendingRead = controller;
        this.battery = this.options.powerMonitor.isOnBatteryPower();
        const idleState = this.options.powerMonitor.getSystemIdleState(
            this.options.idleThresholdSeconds ?? 60
        );
        this.idle = idleState === 'idle' || idleState === 'locked';
        try {
            const state = await this.options.fullscreenProbe.read(controller.signal);
            if (controller.signal.aborted || this.disposed)
                return;
            this.fullscreen = state.fullscreen;
        } catch {
            if (controller.signal.aborted || this.disposed)
                return;
        } finally {
            if (this.pendingRead === controller)
                this.pendingRead = undefined;
        }
        this.emitPerformanceChange();
    }

    getPerformanceMode(): PerformanceMode {
        const context: PerformanceContext = {
            paused: this.paused
                || this.suspended
                || this.presentationActive
                || this.suppressionPolicy.reduceMotion,
            hidden: this.hidden,
            obscured: this.obscured,
            battery: this.battery,
            idle: this.idle,
            fullscreen: this.fullscreen,
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

    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.pendingRead?.abort();
        this.pendingRead = undefined;
        this.unregisterShortcuts();
        this.options.powerMonitor.removeListener('suspend', this.handleSuspend);
        this.options.powerMonitor.removeListener('resume', this.handleResume);
        this.options.tray.destroy();
    }

    private readonly handleSuspend = (): void => {
        this.suspended = true;
        this.pendingRead?.abort();
        this.pendingRead = undefined;
        this.emitPerformanceChange();
    };

    private readonly handleResume = (): void => {
        this.suspended = false;
        void this.refreshSystemState();
    };

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
