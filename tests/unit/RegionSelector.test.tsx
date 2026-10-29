import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RegionSelector, {
    clipRegionSelection,
    handleRegionKeyDown,
    overlayPointToScreenPoint
} from '../../src/renderer/screenshot/RegionSelector';

const viewport = { x: 0, y: 0, width: 100, height: 80 };

describe('RegionSelector', () => {
    it('maps overlay-local pointers onto negative-origin desktop coordinates', () => {
        expect(overlayPointToScreenPoint(
            { x: 10, y: 20 },
            { x: -1_920, y: -200, width: 1_920, height: 1_080 }
        )).toEqual({ x: -1_910, y: -180 });
    });

    it('includes the overlay viewport offset in global coordinates', () => {
        expect(overlayPointToScreenPoint(
            { x: 25, y: 35 },
            { x: 640, y: 360, width: 1_280, height: 720 }
        )).toEqual({ x: 665, y: 395 });
    });

    it('supports selections larger than the 960 by 640 pet window', () => {
        const viewport = { x: -500, y: -300, width: 3_000, height: 1_600 };
        const start = overlayPointToScreenPoint({ x: 0, y: 0 }, viewport);
        const end = overlayPointToScreenPoint({ x: 3_000, y: 1_600 }, viewport);

        expect(start).toEqual({ x: -500, y: -300 });
        expect(end).toEqual({ x: 2_500, y: 1_300 });
        expect(clipRegionSelection(start, end, viewport)).toEqual(viewport);
    });

    it('clips mouse selection to the visible screen bounds', () => {
        expect(clipRegionSelection(
            { x: -20, y: 10 },
            { x: 120, y: 90 },
            viewport
        )).toEqual({
            x: 0,
            y: 10,
            width: 100,
            height: 70
        });
    });

    it('cancels region selection on Escape', () => {
        const onCancel = vi.fn();
        const preventDefault = vi.fn();

        const handled = handleRegionKeyDown({ key: 'Escape', preventDefault }, onCancel);

        expect(handled).toBe(true);
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('renders no overlay until the screenshot shortcut activates selection', () => {
        expect(renderToStaticMarkup(
            <RegionSelector
                active={false}
                viewport={viewport}
                onSelect={vi.fn()}
                onCancel={vi.fn()}
            />
        )).toBe('');
    });

    it('provides explicit mouse and keyboard cancellation controls', () => {
        const markup = renderToStaticMarkup(
            <RegionSelector
                active
                viewport={viewport}
                onSelect={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(markup).toContain('aria-label="Select a screen region"');
        expect(markup).toContain('Cancel');
    });
});
