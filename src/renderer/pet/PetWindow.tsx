import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MascotEvent, MascotState } from '../../shared/contracts';
import { transitionMascotState } from '../../shared/domainState';
import type { PerformanceContext } from '../../main/services/performanceGovernor';
import Live2DStage from './Live2DStage';

const emptyMascotEvents: readonly MascotEvent[] = [];

export interface PetWindowProps {
    modelPath?: string;
    eventBatch?: readonly MascotEvent[];
    eventBatchId?: number;
    performance?: PerformanceContext;
    onMascotStateChange?: (state: MascotState) => void;
    children?: React.ReactNode;
}

function nextMascotState(current: MascotState, event: MascotEvent): MascotState {
    try {
        return transitionMascotState(current, event);
    } catch {
        return current;
    }
}

export default function PetWindow({
    modelPath = import.meta.env.VITE_LIVE2D_MODEL_PATH
        ?? '/live2d/models/Haru/Haru.model3.json',
    eventBatch = emptyMascotEvents,
    eventBatchId = 0,
    performance,
    onMascotStateChange,
    children
}: PetWindowProps): React.JSX.Element {
    const stateRef = useRef<MascotState>('idle');
    const [mascotState, setMascotState] = useState<MascotState>('idle');
    const [renderMode, setRenderMode] = useState<'live2d' | 'static-fallback'>(
        'static-fallback'
    );
    const [runtimePerformance, setRuntimePerformance] = useState<PerformanceContext>(
        () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
            ? { hidden: true }
            : { reason: 'normal' }
    );
    const effectivePerformance = useMemo(() => (
        performance === undefined
            ? runtimePerformance
            : { ...runtimePerformance, ...performance }
    ), [performance, runtimePerformance]);

    const handleRenderModeChange = useCallback((
        mode: 'live2d' | 'static-fallback'
    ): void => {
        setRenderMode(mode);
    }, []);

    useEffect(() => {
        let nextState = stateRef.current;
        for (const event of eventBatch)
            nextState = nextMascotState(nextState, event);
        stateRef.current = nextState;
        setMascotState(nextState);
        onMascotStateChange?.(nextState);
    }, [eventBatch, eventBatchId]);

    useEffect(() => {
        const updatePerformance = (): void => {
            setRuntimePerformance({
                hidden: document.visibilityState === 'hidden'
            });
        };
        updatePerformance();
        document.addEventListener('visibilitychange', updatePerformance);
        return () => {
            document.removeEventListener('visibilitychange', updatePerformance);
        };
    }, []);

    return (
        <div
            data-mascot-state={mascotState}
            data-render-mode={renderMode}
            data-testid="pet-window"
            style={{
                background: 'transparent',
                height: '100%',
                overflow: 'hidden',
                position: 'fixed',
                inset: 0,
                width: '100%',
                WebkitAppRegion: 'no-drag'
            } as React.CSSProperties & { WebkitAppRegion: 'no-drag' }}
        >
            <Live2DStage
                modelPath={modelPath}
                onRenderModeChange={handleRenderModeChange}
                performance={effectivePerformance}
                state={mascotState}
            />
            <div
                aria-label="Drag pet window"
                data-testid="pet-drag-handle"
                style={{
                    height: 32,
                    left: 0,
                    pointerEvents: 'auto',
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    WebkitAppRegion: 'drag'
                } as React.CSSProperties & { WebkitAppRegion: 'drag' }}
            />
            <div
                style={{
                    background: 'rgba(247, 251, 250, 0.92)',
                    border: '1px solid rgba(37, 48, 71, 0.16)',
                    borderRadius: '18px 18px 4px 18px',
                    bottom: 16,
                    boxShadow: '0 12px 32px rgba(37, 48, 71, 0.18)',
                    color: '#253047',
                    display: 'grid',
                    fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
                    gap: 10,
                    maxWidth: 440,
                    padding: 14,
                    pointerEvents: 'auto',
                    right: 16,
                    position: 'absolute',
                    WebkitAppRegion: 'no-drag'
                } as React.CSSProperties & { WebkitAppRegion: 'no-drag' }}
            >
                {children}
                <small>
                    This content uses sample data owned and copyrighted by Live2D Inc.
                </small>
            </div>
        </div>
    );
}
