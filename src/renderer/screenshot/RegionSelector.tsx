import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent
} from 'react';
import type { ScreenBounds } from '../../shared/contracts';
import {
    clipRegionSelection,
    handleRegionKeyDown,
    overlayPointToScreenPoint,
    type RegionPoint
} from './regionSelection';

export {
    clipRegionSelection,
    handleRegionKeyDown,
    overlayPointToScreenPoint,
    type RegionKeyEvent,
    type RegionPoint
} from './regionSelection';

export interface RegionSelectorProps {
    active: boolean;
    viewport: ScreenBounds;
    onSelect(bounds: ScreenBounds): void;
    onCancel(): void;
}

interface RegionSelectionState {
    dragging: boolean;
    start?: RegionPoint;
    current?: RegionPoint;
}

const idleSelection: RegionSelectionState = {
    dragging: false
};

function pointFromPointer(
    event: ReactPointerEvent<HTMLDivElement>,
    viewport: ScreenBounds
): RegionPoint {
    return overlayPointToScreenPoint({
        x: event.clientX,
        y: event.clientY
    }, viewport);
}

function selectionStyle(
    state: RegionSelectionState,
    viewport: ScreenBounds
): React.CSSProperties | undefined {
    if (state.start === undefined || state.current === undefined)
        return undefined;
    const bounds = clipRegionSelection(state.start, state.current, viewport);
    if (bounds === undefined)
        return undefined;
    return {
        left: bounds.x - viewport.x,
        top: bounds.y - viewport.y,
        width: bounds.width,
        height: bounds.height
    };
}

export default function RegionSelector({
    active,
    viewport,
    onSelect,
    onCancel
}: RegionSelectorProps): React.JSX.Element | null {
    const overlayRef = useRef<HTMLDivElement>(null);
    const [selection, setSelection] = useState<RegionSelectionState>(idleSelection);

    useEffect(() => {
        if (active)
            overlayRef.current?.focus();
    }, [active]);

    if (!active)
        return null;

    const finishSelection = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const current = pointFromPointer(event, viewport);
        const start = selection.start ?? current;
        setSelection(idleSelection);
        const bounds = clipRegionSelection(start, current, viewport);
        if (bounds !== undefined)
            onSelect(bounds);
    };

    return (
        <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label="Select a screen region"
            tabIndex={-1}
            style={{
                position: 'fixed',
                inset: 0,
                cursor: 'crosshair',
                background: 'rgba(0, 0, 0, 0.28)',
                touchAction: 'none'
            }}
            onPointerDown={(event) => {
                if (event.button !== 0)
                    return;
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = pointFromPointer(event, viewport);
                setSelection({
                    dragging: true,
                    start: point,
                    current: point
                });
            }}
            onPointerMove={(event) => {
                if (!selection.dragging)
                    return;
                setSelection({
                    ...selection,
                    current: pointFromPointer(event, viewport)
                });
            }}
            onPointerUp={(event) => {
                if (!selection.dragging)
                    return;
                finishSelection(event);
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
                handleRegionKeyDown(event, onCancel);
            }}
        >
            <div
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    border: '2px solid #fff',
                    background: 'rgba(79, 70, 229, 0.18)',
                    pointerEvents: 'none',
                    ...selectionStyle(selection, viewport)
                }}
            />
            <button type="button" onClick={onCancel}>Cancel</button>
        </div>
    );
}
