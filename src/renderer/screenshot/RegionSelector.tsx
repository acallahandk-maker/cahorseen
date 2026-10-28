import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent
} from 'react';
import type { ScreenBounds } from '../../shared/contracts';

export interface RegionPoint {
    x: number;
    y: number;
}

export interface RegionKeyEvent {
    key: string;
    preventDefault(): void;
}

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

function pointFromPointer(
    event: ReactPointerEvent<HTMLDivElement>,
    viewport: ScreenBounds
): RegionPoint {
    return {
        x: viewport.x + event.clientX,
        y: viewport.y + event.clientY
    };
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
