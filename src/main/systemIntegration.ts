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

export interface SystemIntegrationOptions {
    shortcutRegistrar: ShortcutRegistrar;
    tray: TrayLike;
    buildMenu(template: MenuItemTemplate[]): unknown;
    powerMonitor: PowerMonitorLike;
    onSelectionShortcut(): void;
    onScreenshotShortcut(): void;
    onShow(): void;
    onOpenSettings(): void;
    onCheckUpdates(): void;
    onPausedChange(paused: boolean): void;
    onExit(): void;
    onPerformanceChange?(mode: PerformanceMode): void;
    idleThresholdSeconds?: number;
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
        pauseWhenFullscreen: policy.pauseWhenFullscreen
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
        pauseWhenFullscreen: true
    };
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
        void this.refreshSystemState();
    }

    getQuizInterruptionState(): QuizInterruptionState {
        return {
            fullscreen: this.fullscreen,
            activeTranslation: this.activeTranslation,
            intenseInput: this.intenseInput
                || this.presentationActive
                || this.hidden
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
        this.battery = this.options.powerMonitor.isOnBatteryPower();
        const idleState = this.options.powerMonitor.getSystemIdleState(
            this.options.idleThresholdSeconds ?? 60
        );
        this.idle = idleState === 'idle' || idleState === 'locked';
        this.emitPerformanceChange();
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
        this.disposePromise = (async () => {
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
        this.emitPerformanceChange();
    };

    private readonly handleResume = (): void => {
        this.suspended = false;
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
                label: 'Check updates',
                click: () => this.options.onCheckUpdates()
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
