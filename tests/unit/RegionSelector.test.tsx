import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RegionSelector, {
    clipRegionSelection,
    handleRegionKeyDown
} from '../../src/renderer/screenshot/RegionSelector';

const viewport = { x: 0, y: 0, width: 100, height: 80 };

describe('RegionSelector', () => {
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
