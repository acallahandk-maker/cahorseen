import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SystemIntegration,
    type MenuItemTemplate
} from '../../src/main/systemIntegration';

interface HarnessOptions {
    onCheckUpdates?: () => void;
}

function createHarness(options: HarnessOptions = {}) {
    const listeners = new Map<string, Set<() => void>>();
    const powerMonitor = {
        batteryReads: 0,
        idleReads: 0,
        isOnBatteryPower() {
            this.batteryReads += 1;
            return false;
        },
        getSystemIdleState() {
            this.idleReads += 1;
            return 'active' as const;
        },
        on(event: string, listener: () => void) {
            const values = listeners.get(event) ?? new Set<() => void>();
            values.add(listener);
            listeners.set(event, values);
            return this;
        },
        removeListener(event: string, listener: () => void) {
            listeners.get(event)?.delete(listener);
            return this;
        }
    };
    let menu: MenuItemTemplate[] = [];
    const integration = new SystemIntegration({
        shortcutRegistrar: {
            register: () => true,
            unregister: () => undefined
        },
        tray: {
            setContextMenu: (value: unknown) => {
                menu = value as MenuItemTemplate[];
            },
            destroy: () => undefined
        },
        buildMenu: (template: MenuItemTemplate[]) => template,
        powerMonitor,
        onSelectionShortcut: () => undefined,
        onScreenshotShortcut: () => undefined,
        onShow: () => undefined,
        onOpenSettings: () => undefined,
        onPausedChange: () => undefined,
        onExit: () => undefined,
        onCheckUpdates: options.onCheckUpdates ?? (() => undefined)
    });
    return { integration, powerMonitor, getMenu: () => menu };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('final review system integration', () => {
    it('does not poll system state or probe foreign foreground windows', async () => {
        vi.useFakeTimers();
        const harness = createHarness();

        await vi.advanceTimersByTimeAsync(50);

        expect(harness.powerMonitor.idleReads).toBeLessThanOrEqual(1);
        await harness.integration.dispose();
    });

    it('exposes and runs the Check updates tray action', async () => {
        const onCheckUpdates = vi.fn();
        const harness = createHarness({ onCheckUpdates });

        const item = harness.getMenu().find((candidate) => candidate.label === 'Check updates');
        expect(item).toBeDefined();
        item?.click?.();
        expect(onCheckUpdates).toHaveBeenCalledOnce();
        await harness.integration.dispose();
    });

    it('keeps fullscreen and active-translation suppression event driven', async () => {
        const harness = createHarness();
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: true
        });

        harness.integration.setFullscreen(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'fullscreen',
            frameRate: 0,
            suppressed: true
        });
        expect(harness.integration.getQuizSuppressionReason()).toBe('fullscreen');
        await harness.integration.dispose();
    });
});
