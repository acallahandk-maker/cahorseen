import type { ScreenBounds } from '../../shared/contracts';

export interface RegionPoint {
    x: number;
    y: number;
}

export interface RegionKeyEvent {
    key: string;
    preventDefault(): void;
}

export function clipRegionSelection(
    start: RegionPoint,
    end: RegionPoint,
    viewport: ScreenBounds
): ScreenBounds | undefined {
    const left = Math.max(viewport.x, Math.min(start.x, end.x));
    const top = Math.max(viewport.y, Math.min(start.y, end.y));
    const right = Math.min(
        viewport.x + viewport.width,
        Math.max(start.x, end.x)
    );
    const bottom = Math.min(
        viewport.y + viewport.height,
        Math.max(start.y, end.y)
    );
    const width = Math.floor(right - left);
    const height = Math.floor(bottom - top);
    if (width < 1 || height < 1)
        return undefined;
    return {
        x: Math.floor(left),
        y: Math.floor(top),
        width,
        height
    };
}

export function handleRegionKeyDown(
    event: RegionKeyEvent,
    onCancel: () => void
): boolean {
    if (event.key !== 'Escape')
        return false;
    event.preventDefault();
    onCancel();
    return true;
}
