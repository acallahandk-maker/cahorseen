import { useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import {
    mascotHandleSchema,
    mascotStateSchema,
    type MascotHandle,
    type MascotState
} from '../../shared/contracts';
import {
    resolvePerformanceMode,
    shouldPauseLoop,
    type PerformanceContext
} from '../../main/services/performanceGovernor';

interface MascotCoreModel {
    setParameterValueById(parameterId: string, value: number): void;
}

interface MascotModelFactory {
    from(
        source: string,
        options: {
            autoUpdate: false;
            autoInteract: false;
        }
    ): Promise<unknown>;
}

export interface MascotDisplayModel {
    anchor: {
        set(x: number, y: number): void;
    };
    position: {
        set(x: number, y: number): void;
    };
    visible: boolean;
    autoUpdate: boolean;
    autoInteract: boolean;
    motion(group: string, index?: number, priority?: number): Promise<boolean>;
    update(deltaMs: number): void;
    destroy(options?: {
        children?: boolean;
        texture?: boolean;
        baseTexture?: boolean;
    }): void;
    internalModel: {
        coreModel: MascotCoreModel;
        destroy(): void;
    };
}

export interface MascotStateCue {
    action: string;
    parameters: Readonly<Record<string, number>>;
}

export const mascotStateCues: Readonly<Record<MascotState, MascotStateCue>> = {
    idle: {
        action: 'Idle',
        parameters: {
            ParamAngleX: 0,
            ParamAngleY: 0,
            ParamBrowLY: 0,
            ParamBrowRY: 0,
            ParamEyeLOpen: 1,
            ParamEyeROpen: 1,
            ParamMouthOpenY: 0,
            ParamMouthForm: 0
        }
    },
    listening: {
        action: 'Listen',
        parameters: {
            ParamAngleX: 2,
            ParamAngleY: -1,
            ParamBrowLY: 0.2,
            ParamBrowRY: 0.2,
            ParamEyeLOpen: 1,
            ParamEyeROpen: 1,
            ParamMouthOpenY: 0.04,
            ParamMouthForm: 0.1
        }
    },
    thinking: {
        action: 'Thinking',
        parameters: {
            ParamAngleX: -5,
            ParamAngleY: 3,
            ParamBrowLY: 0.7,
            ParamBrowRY: 0.7,
            ParamEyeLOpen: 0.85,
            ParamEyeROpen: 0.85,
            ParamMouthOpenY: 0.08,
            ParamMouthForm: -0.15
        }
    },
    success: {
        action: 'Success',
        parameters: {
            ParamAngleX: 4,
            ParamAngleY: -2,
            ParamBrowLY: 0.5,
            ParamBrowRY: 0.5,
            ParamEyeLOpen: 1,
            ParamEyeROpen: 1,
            ParamMouthOpenY: 0.25,
            ParamMouthForm: 1
        }
    },
    error: {
        action: 'Error',
        parameters: {
            ParamAngleX: -3,
            ParamAngleY: 2,
            ParamBrowLY: -0.6,
            ParamBrowRY: -0.6,
            ParamEyeLOpen: 0.7,
            ParamEyeROpen: 0.7,
            ParamMouthOpenY: 0.15,
            ParamMouthForm: -0.8
        }
    },
    quizzing: {
        action: 'Quiz',
        parameters: {
            ParamAngleX: 6,
            ParamAngleY: -4,
            ParamBrowLY: 0.45,
            ParamBrowRY: 0.45,
            ParamEyeLOpen: 1,
            ParamEyeROpen: 1,
            ParamMouthOpenY: 0.12,
            ParamMouthForm: 0.1
        }
    },
    happy: {
        action: 'Happy',
        parameters: {
            ParamAngleX: 3,
            ParamAngleY: -5,
            ParamBrowLY: 0.65,
            ParamBrowRY: 0.65,
            ParamEyeLOpen: 0.25,
            ParamEyeROpen: 0.25,
            ParamMouthOpenY: 0.45,
            ParamMouthForm: 1
        }
    },
    sad: {
        action: 'Sad',
        parameters: {
            ParamAngleX: -4,
            ParamAngleY: 6,
            ParamBrowLY: -0.45,
            ParamBrowRY: -0.45,
            ParamEyeLOpen: 0.35,
            ParamEyeROpen: 0.35,
            ParamMouthOpenY: 0.18,
            ParamMouthForm: -1
        }
    }
};

interface MascotRuntime {
    handle: MascotHandle;
    kind: 'live2d' | 'fallback';
    model?: MascotDisplayModel;
}

class MascotValidationError extends Error {}

const modelRuntimes = new Map<string, MascotRuntime>();
let mascotSequence = 0;
let cubismCorePromise: Promise<void> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function validateLocalPath(value: string, label: string): void {
    if (
        value.includes('\\')
        || value.includes('\0')
        || /^[a-zA-Z]:/.test(value)
        || /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value)
    )
        throw new MascotValidationError(`${label} must be local`);

    const pathPart = value.split(/[?#]/, 1)[0];
    const segments = pathPart.split('/');
    let decodedSegments: string[];
    try {
        decodedSegments = segments.map((segment) => decodeURIComponent(segment));
    } catch {
        throw new MascotValidationError(`${label} contains invalid encoding`);
    }
    if (decodedSegments.some((segment) => (
        segment === '..'
        || segment === '.'
        || segment.includes('/')
        || segment.includes('\\')
        || segment.includes('\0')
    ))) {
        throw new MascotValidationError(label === 'Model path'
            ? 'Model path must stay inside the model directory'
            : 'Model reference escapes the model directory');
    }
}

function validateRelativeReference(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0)
        throw new MascotValidationError(`${label} must be a non-empty string`);
    validateLocalPath(value, label);
    if (value.startsWith('/'))
        throw new MascotValidationError(`${label} must be relative to the model directory`);
    return value;
}

interface ValidatedModelManifest {
    moc: string;
    textures: string[];
    motions: Record<string, unknown>;
}

function validateModelManifest(value: unknown): ValidatedModelManifest {
    if (!isRecord(value))
        throw new MascotValidationError('Model manifest must be an object');
    const version = value.Version;
    if (
        !isRecord(version)
        || version.Major !== 3
        || typeof version.Minor !== 'number'
    )
        throw new MascotValidationError('Only Cubism 3 model manifests are supported');

    const fileReferences = value.FileReferences;
    if (!isRecord(fileReferences))
        throw new MascotValidationError('Model manifest is missing FileReferences');
    const moc = validateRelativeReference(fileReferences.Moc, 'Moc reference');
    if (!moc.endsWith('.moc3'))
        throw new MascotValidationError('Moc reference must point to a .moc3 file');

    const rawTextures = fileReferences.Textures;
    if (!Array.isArray(rawTextures) || rawTextures.length === 0)
        throw new MascotValidationError('Model manifest must contain textures');
    const textures = rawTextures.map((texture) => {
        const reference = validateRelativeReference(texture, 'Texture reference');
        if (!/\.(?:png|jpe?g|webp)$/i.test(reference))
            throw new MascotValidationError('Texture reference has an unsupported format');
        return reference;
    });

    const rawMotions = fileReferences.Motions;
    const motions: Record<string, unknown> = isRecord(rawMotions) ? rawMotions : {};
    for (const group of Object.values(motions)) {
        if (!Array.isArray(group))
            throw new MascotValidationError('Motion groups must be arrays');
        for (const motion of group) {
            if (!isRecord(motion))
                throw new MascotValidationError('Motion entries must be objects');
            const reference = validateRelativeReference(motion.File, 'Motion reference');
            if (!reference.endsWith('.motion3.json'))
                throw new MascotValidationError('Motion reference has an unsupported format');
        }
    }
    const requiredActions = new Set(
        Object.values(mascotStateCues).map((cue) => cue.action)
    );
    for (const action of requiredActions) {
        const group = motions[action];
        if (!Array.isArray(group) || group.length === 0)
            throw new MascotValidationError(`Model manifest is missing motion group ${action}`);
    }

    return { moc, textures, motions };
}

async function loadManifest(modelPath: string): Promise<ValidatedModelManifest> {
    const response = await fetch(modelPath, { cache: 'force-cache' });
    if (!response.ok)
        throw new Error(`Model manifest request failed with ${response.status}`);
    return validateModelManifest(await response.json());
}

async function ensureCubismCore(): Promise<void> {
    const scope = globalThis as typeof globalThis & {
        Live2DCubismCore?: unknown;
        document?: Document;
    };
    if (scope.Live2DCubismCore !== undefined)
        return;
    cubismCorePromise ??= new Promise<void>((resolve, reject) => {
        const documentObject = scope.document;
        if (documentObject === undefined) {
            reject(new Error('Cubism runtime is unavailable'));
            return;
        }
        const script = documentObject.createElement('script');
        script.src = '/live2d/live2dcubismcore.min.js';
        script.async = true;
        script.dataset.live2dCubismCore = 'true';
        script.addEventListener('load', () => {
            if (scope.Live2DCubismCore !== undefined)
                resolve();
            else
                reject(new Error('Cubism runtime did not initialize'));
        }, { once: true });
        script.addEventListener('error', () => {
            reject(new Error('Cubism runtime could not be loaded'));
        }, { once: true });
        documentObject.head.appendChild(script);
    });
    await cubismCorePromise;
}

async function loadMascotModelFactory(): Promise<MascotModelFactory> {
    const module = await import('pixi-live2d-display/lib/cubism4') as unknown as {
        Live2DModel?: MascotModelFactory;
        default?: {
            Live2DModel?: MascotModelFactory;
        };
    };
    const factory = module.Live2DModel ?? module.default?.Live2DModel;
    if (factory === undefined)
        throw new Error('Live2D model factory is unavailable');
    return factory;
}

function createHandle(kind: MascotRuntime['kind']): MascotHandle {
    mascotSequence += 1;
    return mascotHandleSchema.parse({
        id: `${kind === 'fallback' ? 'fallback' : 'mascot'}-${mascotSequence}`,
        x: 480,
        y: 320,
        visible: true
    });
}

function destroyRuntime(runtime: MascotRuntime): void {
    runtime.model?.destroy({
        children: true,
        texture: true,
        baseTexture: true
    });
}

function registerRuntime(runtime: MascotRuntime): MascotHandle {
    while (modelRuntimes.size >= 2) {
        const oldestId = modelRuntimes.keys().next().value;
        if (oldestId === undefined)
            break;
        const oldest = modelRuntimes.get(oldestId);
        if (oldest !== undefined)
            destroyRuntime(oldest);
        modelRuntimes.delete(oldestId);
    }
    modelRuntimes.set(runtime.handle.id, runtime);
    return runtime.handle;
}

function asDisplayModel(value: unknown): MascotDisplayModel {
    if (!isRecord(value))
        throw new Error('Live2D runtime returned an invalid model');
    const model = value as unknown as MascotDisplayModel;
    if (
        typeof model.motion !== 'function'
        || typeof model.update !== 'function'
        || typeof model.destroy !== 'function'
        || !isRecord(model.internalModel)
        || !isRecord(model.internalModel.coreModel)
        || typeof model.internalModel.coreModel.setParameterValueById !== 'function'
        || typeof model.internalModel.destroy !== 'function'
    )
        throw new Error('Live2D runtime returned an unsupported model');
    return model;
}

export async function loadMascotModel(modelPath: string): Promise<MascotHandle> {
    try {
        validateLocalPath(modelPath, 'Model path');
        if (!modelPath.split(/[?#]/, 1)[0].endsWith('.model3.json'))
            throw new MascotValidationError('Model path must point to a .model3.json file');
        await loadManifest(modelPath);
        await ensureCubismCore();
        const modelFactory = await loadMascotModelFactory();
        const model = asDisplayModel(await modelFactory.from(modelPath, {
            autoUpdate: false,
            autoInteract: false
        }));
        const handle = createHandle('live2d');
        model.anchor.set(0.5, 0.5);
        model.position.set(handle.x, handle.y);
        model.visible = handle.visible;
        return registerRuntime({ handle, kind: 'live2d', model });
    } catch (error) {
        if (error instanceof MascotValidationError)
            throw error;
        return registerRuntime({
            handle: createHandle('fallback'),
            kind: 'fallback'
        });
    }
}

export function getMascotModel(handle: MascotHandle): MascotDisplayModel | undefined {
    return modelRuntimes.get(handle.id)?.model;
}

export function isMascotFallback(handle: MascotHandle): boolean {
    return modelRuntimes.get(handle.id)?.kind === 'fallback';
}

export async function setMascotState(
    handle: MascotHandle,
    state: MascotState
): Promise<void> {
    const runtime = modelRuntimes.get(handle.id);
    if (runtime === undefined)
        throw new Error('Mascot handle is no longer active');
    const nextState = mascotStateSchema.parse(state);
    if (runtime.kind === 'fallback' || runtime.model === undefined)
        return;

    const cue = mascotStateCues[nextState];
    for (const [parameterId, value] of Object.entries(cue.parameters))
        runtime.model.internalModel.coreModel.setParameterValueById(parameterId, value);
    try {
        await runtime.model.motion(cue.action, 0, 3);
    } catch {
        return;
    }
}

export function disposeMascotModel(handle: MascotHandle): void {
    const runtime = modelRuntimes.get(handle.id);
    if (runtime === undefined)
        return;
    destroyRuntime(runtime);
    modelRuntimes.delete(handle.id);
}

export interface FrameTickerLike {
    maxFPS: number;
    start(): void;
    stop(): void;
}

export function configureFrameTicker(
    ticker: FrameTickerLike,
    context: PerformanceContext
): void {
    ticker.maxFPS = resolvePerformanceMode(context).frameRate;
    if (shouldPauseLoop(context))
        ticker.stop();
    else
        ticker.start();
}

export interface Live2DStageProps {
    modelPath: string;
    state: MascotState;
    performance?: PerformanceContext;
    onRenderModeChange?: (mode: 'live2d' | 'static-fallback') => void;
}

function StaticMascot({ state }: { state: MascotState }): React.JSX.Element {
    return (
        <svg
            aria-label="Static mascot fallback"
            data-mascot-state={state}
            height="100%"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            viewBox="0 0 640 480"
            width="100%"
        >
            <ellipse cx="315" cy="275" rx="190" ry="135" fill="#f5b85b" />
            <path d="M142 276C76 216 54 170 68 129c61 16 111 59 132 112z" fill="#ee8d57" />
            <ellipse cx="245" cy="235" rx="31" ry="39" fill="#fff" />
            <ellipse cx="390" cy="235" rx="31" ry="39" fill="#fff" />
            <circle cx="252" cy="244" r="13" fill="#253047" />
            <circle cx="383" cy="244" r="13" fill="#253047" />
            <path d="M276 324c31 24 65 24 96 0" fill="none" stroke="#253047" strokeLinecap="round" strokeWidth="12" />
            <ellipse cx="198" cy="310" rx="32" ry="16" fill="#ee8d57" opacity="0.7" />
            <ellipse cx="438" cy="310" rx="32" ry="16" fill="#ee8d57" opacity="0.7" />
        </svg>
    );
}

export default function Live2DStage({
    modelPath,
    state,
    performance,
    onRenderModeChange
}: Live2DStageProps): React.JSX.Element {
    const containerRef = useRef<HTMLDivElement>(null);
    const appRef = useRef<Application | undefined>(undefined);
    const modelHandleRef = useRef<MascotHandle | undefined>(undefined);
    const [renderMode, setRenderMode] = useState<'live2d' | 'static-fallback'>(
        'static-fallback'
    );

    useEffect(() => {
        let disposed = false;
        const container = containerRef.current;
        if (container === null)
            return;

        void (async () => {
            const handle = await loadMascotModel(modelPath);
            if (disposed) {
                disposeMascotModel(handle);
                return;
            }
            modelHandleRef.current = handle;
            const model = getMascotModel(handle);
            if (model === undefined) {
                setRenderMode('static-fallback');
                return;
            }
            const app = new Application({
                width: 960,
                height: 640,
                antialias: true,
                autoStart: false,
                autoDensity: true,
                transparent: true,
                resolution: Math.min(window.devicePixelRatio || 1, 2)
            });
            appRef.current = app;
            container.appendChild(app.view);
            app.stage.addChild(model as unknown as Parameters<typeof app.stage.addChild>[0]);
            app.ticker.add(() => {
                model.update(app.ticker.deltaMS);
            });
            setRenderMode('live2d');
        })().catch(() => {
            if (!disposed)
                setRenderMode('static-fallback');
        });

        return () => {
            disposed = true;
            const handle = modelHandleRef.current;
            if (handle !== undefined)
                disposeMascotModel(handle);
            modelHandleRef.current = undefined;
            appRef.current?.destroy(true, {
                children: false,
                texture: false,
                baseTexture: false
            });
            appRef.current = undefined;
        };
    }, [modelPath]);

    useEffect(() => {
        const handle = modelHandleRef.current;
        if (handle !== undefined)
            void setMascotState(handle, state);
    }, [renderMode, state]);

    useEffect(() => {
        const ticker = appRef.current?.ticker;
        if (ticker !== undefined)
            configureFrameTicker(ticker, performance ?? { reason: 'normal' });
    }, [performance, renderMode]);

    useEffect(() => {
        onRenderModeChange?.(renderMode);
    }, [onRenderModeChange, renderMode]);

    return (
        <div
            aria-label="Live2D mascot stage"
            data-render-mode={renderMode}
            data-testid="live2d-stage"
            ref={containerRef}
            style={{
                height: '100%',
                overflow: 'hidden',
                position: 'relative',
                width: '100%'
            }}
        >
            {renderMode === 'static-fallback' ? <StaticMascot state={state} /> : null}
        </div>
    );
}
