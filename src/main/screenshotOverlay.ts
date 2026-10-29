import { z } from 'zod';
import {
    screenshotIpcChannels,
    screenshotSelectionSchema,
    type ScreenBounds
} from '../shared/contracts';

export interface ScreenshotOverlayOwner {
    send(channel: string, payload: unknown): void;
}

export interface ScreenshotOverlayWindowLike {
    loadURL(url: string): Promise<unknown>;
    show(): void;
    focus(): void;
    close(): void;
    isDestroyed(): boolean;
    once(event: 'closed', listener: () => void): void;
}

export interface ScreenshotOverlayWindowOptions {
    bounds: ScreenBounds;
    frame: boolean;
    transparent: boolean;
    alwaysOnTop: boolean;
    skipTaskbar: boolean;
    resizable: boolean;
    movable: boolean;
    minimizable: boolean;
    maximizable: boolean;
    fullscreenable: boolean;
    focusable: boolean;
    show: boolean;
    enableLargerThanScreen: boolean;
    hasShadow: boolean;
}

export interface ScreenshotOverlayIpcMainLike {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void;
    removeHandler(channel: string): void;
}

export interface ScreenshotOverlayControllerOptions {
    ipcMain: ScreenshotOverlayIpcMainLike;
    overlayUrl: string;
    getDisplays(): ScreenBounds[];
    createWindow(options: ScreenshotOverlayWindowOptions): ScreenshotOverlayWindowLike;
    onSelected(bounds: ScreenBounds, owner: ScreenshotOverlayOwner): void;
    isSenderAuthorized(event: unknown, channel?: string): boolean;
}

interface ActiveScreenshotOverlay {
    window: ScreenshotOverlayWindowLike;
    owner: ScreenshotOverlayOwner;
    viewport: ScreenBounds;
    selected?: ScreenBounds;
}

type ScreenshotOverlayIpcResult =
    | { ok: true }
    | { ok: true; value: ScreenBounds }
    | {
        ok: false;
        error: {
            code: 'unauthorized' | 'invalid-request';
            message: string;
        };
    };

const emptyPayloadSchema = z.strictObject({});

function failure(code: 'unauthorized' | 'invalid-request', message: string): ScreenshotOverlayIpcResult {
    return {
        ok: false,
        error: { code, message }
    };
}

function ownerFromEvent(event: unknown): ScreenshotOverlayOwner | undefined {
    const sender = (event as { sender?: unknown }).sender;
    if (sender === null || typeof sender !== 'object')
        return undefined;
    const send = (sender as { send?: unknown }).send;
    return typeof send === 'function'
        ? sender as ScreenshotOverlayOwner
        : undefined;
}

function containsBounds(outer: ScreenBounds, inner: ScreenBounds): boolean {
    return inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height;
}

export function virtualDesktopBounds(displays: ScreenBounds[]): ScreenBounds {
    if (displays.length === 0)
        throw new Error('No displays are available.');
    const left = Math.min(...displays.map((display) => display.x));
    const top = Math.min(...displays.map((display) => display.y));
    const right = Math.max(...displays.map((display) => display.x + display.width));
    const bottom = Math.max(...displays.map((display) => display.y + display.height));
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
    };
}

export class ScreenshotOverlayController {
    private readonly ipcMain: ScreenshotOverlayIpcMainLike;
    private readonly overlayUrl: string;
    private readonly getDisplays: () => ScreenBounds[];
    private readonly createWindow: (
        options: ScreenshotOverlayWindowOptions
    ) => ScreenshotOverlayWindowLike;
    private readonly onSelected: (
        bounds: ScreenBounds,
        owner: ScreenshotOverlayOwner
    ) => void;
    private readonly isSenderAuthorized: (
        event: unknown,
        channel?: string
    ) => boolean;
    private active?: ActiveScreenshotOverlay;
    private opening?: Promise<void>;

    constructor(options: ScreenshotOverlayControllerOptions) {
        this.ipcMain = options.ipcMain;
        this.overlayUrl = options.overlayUrl;
        this.getDisplays = options.getDisplays;
        this.createWindow = options.createWindow;
        this.onSelected = options.onSelected;
        this.isSenderAuthorized = options.isSenderAuthorized;
        this.ipcMain.handle(screenshotIpcChannels.open, async (event, payload) => {
            if (!this.isSenderAuthorized(event, screenshotIpcChannels.open))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = emptyPayloadSchema.safeParse(payload ?? {});
            if (!parsed.success)
                return failure('invalid-request', 'Screenshot selection request is invalid.');
            const owner = ownerFromEvent(event);
            if (owner === undefined)
                return failure('invalid-request', 'Screenshot selection owner is invalid.');
            try {
                await this.open(owner);
                return { ok: true };
            } catch {
                return failure('invalid-request', 'Screenshot selection could not be opened.');
            }
        });
        this.ipcMain.handle(screenshotIpcChannels.overlayViewport, (event, payload) => {
            if (!this.isSenderAuthorized(event, screenshotIpcChannels.overlayViewport))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = emptyPayloadSchema.safeParse(payload ?? {});
            if (!parsed.success || this.active === undefined)
                return failure('invalid-request', 'Screenshot selection is not open.');
            return { ok: true, value: this.active.viewport };
        });
        this.ipcMain.handle(screenshotIpcChannels.select, (event, payload) => {
            if (!this.isSenderAuthorized(event, screenshotIpcChannels.select))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = screenshotSelectionSchema.safeParse(payload);
            if (
                !parsed.success
                || this.active === undefined
                || !containsBounds(this.active.viewport, parsed.data.bounds)
            )
                return failure('invalid-request', 'Screenshot selection bounds are invalid.');
            this.active.selected = parsed.data.bounds;
            this.closeActive();
            return { ok: true };
        });
        this.ipcMain.handle(screenshotIpcChannels.cancelSelection, (event, payload) => {
            if (!this.isSenderAuthorized(event, screenshotIpcChannels.cancelSelection))
                return failure('unauthorized', 'IPC sender is not authorized.');
            const parsed = emptyPayloadSchema.safeParse(payload ?? {});
            if (!parsed.success || this.active === undefined)
                return failure('invalid-request', 'Screenshot selection is not open.');
            this.active.selected = undefined;
            this.closeActive();
            return { ok: true };
        });
    }

    async open(owner: ScreenshotOverlayOwner): Promise<void> {
        if (this.opening !== undefined)
            return this.opening;
        if (this.active !== undefined)
            return;
        this.opening = this.openNow(owner);
        try {
            await this.opening;
        } finally {
            this.opening = undefined;
        }
    }

    dispose(): void {
        this.ipcMain.removeHandler(screenshotIpcChannels.open);
        this.ipcMain.removeHandler(screenshotIpcChannels.overlayViewport);
        this.ipcMain.removeHandler(screenshotIpcChannels.select);
        this.ipcMain.removeHandler(screenshotIpcChannels.cancelSelection);
        if (this.active !== undefined) {
            this.active.selected = undefined;
            this.closeActive();
        }
    }

    private async openNow(owner: ScreenshotOverlayOwner): Promise<void> {
        const viewport = virtualDesktopBounds(this.getDisplays());
        const overlayWindow = this.createWindow({
            bounds: viewport,
            frame: false,
            transparent: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            focusable: true,
            show: false,
            enableLargerThanScreen: true,
            hasShadow: false
        });
        const active: ActiveScreenshotOverlay = {
            window: overlayWindow,
            owner,
            viewport
        };
        this.active = active;
        overlayWindow.once('closed', () => {
            if (this.active !== active)
                return;
            this.active = undefined;
            if (active.selected !== undefined)
                this.onSelected(active.selected, active.owner);
        });
        try {
            await overlayWindow.loadURL(this.overlayUrl);
            if (this.active !== active)
                return;
            overlayWindow.show();
            overlayWindow.focus();
        } catch (error) {
            if (this.active === active) {
                this.active = undefined;
                if (!overlayWindow.isDestroyed())
                    overlayWindow.close();
            }
            throw error;
        }
    }

    private closeActive(): void {
        if (this.active !== undefined && !this.active.window.isDestroyed())
            this.active.window.close();
    }
}
