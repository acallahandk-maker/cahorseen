import { useEffect, useRef, useState } from 'react';
import { install as installPixiUnsafeEval } from '@pixi/unsafe-eval';
import { Application, systems } from 'pixi.js';
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
    getParameterCount(): number;
}

interface MascotModelFactory {
    from(
        source: string,
        options: {
            autoUpdate: false;
            autoInteract: true;
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
    scale: {
        set(x: number, y: number): void;
    };
    visible: boolean;
    autoUpdate: boolean;
    autoInteract: boolean;
    interactive: boolean;
    textures: unknown[];
    motion(group: string, index?: number, priority?: number): Promise<boolean>;
    update(deltaMs: number): void;
    focus(x: number, y: number, instant?: boolean): void;
    tap(x: number, y: number): void;
    hitTest(x: number, y: number): string[];
    on(event: 'hit', listener: (hitAreas: string[]) => void): void;
    destroy(options?: {
        children?: boolean;
        texture?: boolean;
        baseTexture?: boolean;
    }): void;
    internalModel: {
        width: number;
        height: number;
        hitAreas: Record<string, unknown>;
        motionManager: {
            definitions: Record<string, unknown>;
        };
        coreModel: MascotCoreModel;
        destroy(): void;
    };
}

export interface MascotStateCue {
    action: string;
    parameters: Readonly<Record<string, number>>;
}

export interface MascotStateDiagnostic {
    state: MascotState;
    action: string;
    parameters: Record<string, number>;
    motionStarted: boolean;
}

export interface MascotDiagnostics {
    model: {
        autoInteract: boolean;
        parameterCount: number;
        textureCount: number;
        motionGroupCount: number;
        hitAreas: string[];
    };
    stateMappings: MascotStateDiagnostic[];
    tapCount: number;
    fallbackReason?: string;
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
    diagnostics: MascotDiagnostics;
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
        || /^[a-z][a-z\d+.-]*:/i.test(value)
        || value.startsWith('//')
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

function resolveLocalSource(value: string): string {
    if (typeof document === 'undefined')
        return value;
    const relativeValue = value.startsWith('/') ? `.${value}` : value;
    return new URL(relativeValue, document.baseURI).href;
}

function validateOptionalReference(
    value: unknown,
    label: string,
    extension: RegExp
): string | undefined {
    if (value === undefined)
        return undefined;
    const reference = validateRelativeReference(value, label);
    if (!extension.test(reference))
        throw new MascotValidationError(`${label} has an unsupported format`);
    return reference;
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
        version !== 3
        && (!isRecord(version)
            || version.Major !== 3
            || typeof version.Minor !== 'number')
    )
        throw new MascotValidationError('Only Cubism model3 version 3 manifests are supported');

    const fileReferences = value.FileReferences;
    if (!isRecord(fileReferences))
        throw new MascotValidationError('Model manifest is missing FileReferences');
    const supportedReferences = new Set([
        'Moc',
        'Textures',
        'Physics',
        'Pose',
        'DisplayInfo',
        'Expressions',
        'Motions',
        'UserData'
    ]);
    for (const key of Object.keys(fileReferences)) {
        if (!supportedReferences.has(key))
            throw new MascotValidationError(`Unsupported FileReferences key ${key}`);
    }
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
    validateOptionalReference(
        fileReferences.Physics,
        'Physics reference',
        /\.physics3\.json$/i
    );
    validateOptionalReference(
        fileReferences.Pose,
        'Pose reference',
        /\.pose3\.json$/i
    );
    validateOptionalReference(
        fileReferences.DisplayInfo,
        'DisplayInfo reference',
        /\.cdi3\.json$/i
    );
    validateOptionalReference(
        fileReferences.UserData,
        'UserData reference',
        /\.userdata3\.json$/i
    );

    const rawExpressions = fileReferences.Expressions;
    if (rawExpressions !== undefined) {
        if (!Array.isArray(rawExpressions))
            throw new MascotValidationError('Expressions must be an array');
        for (const expression of rawExpressions) {
            if (!isRecord(expression))
                throw new MascotValidationError('Expression entries must be objects');
            const reference = validateRelativeReference(
                expression.File,
                'Expression reference'
            );
            if (!reference.endsWith('.exp3.json'))
                throw new MascotValidationError('Expression reference has an unsupported format');
        }
    }

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
            validateOptionalReference(
                motion.Sound,
                'Sound reference',
                /\.(?:wav|mp3|ogg)$/i
            );
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
    const response = await fetch(resolveLocalSource(modelPath), { cache: 'force-cache' });
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
        script.src = resolveLocalSource('/live2d/live2dcubismcore.min.js');
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

function createDiagnostics(
    model?: MascotDisplayModel,
    fallbackReason?: string
): MascotDiagnostics {
    return {
        model: {
            autoInteract: model?.autoInteract === true,
            parameterCount: model?.internalModel.coreModel.getParameterCount() ?? 0,
            textureCount: model?.textures.length ?? 0,
            motionGroupCount: model
                ? Object.keys(model.internalModel.motionManager.definitions).length
                : 0,
            hitAreas: model ? Object.keys(model.internalModel.hitAreas).sort() : []
        },
        stateMappings: [],
        tapCount: 0,
        ...(fallbackReason === undefined ? {} : { fallbackReason })
    };
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
        || typeof model.focus !== 'function'
        || typeof model.tap !== 'function'
        || typeof model.hitTest !== 'function'
        || typeof model.on !== 'function'
        || !isRecord(model.internalModel)
        || !isRecord(model.internalModel.coreModel)
        || typeof model.internalModel.coreModel.setParameterValueById !== 'function'
        || typeof model.internalModel.coreModel.getParameterCount !== 'function'
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
        const model = asDisplayModel(await modelFactory.from(resolveLocalSource(modelPath), {
            autoUpdate: false,
            autoInteract: true
        }));
        const handle = createHandle('live2d');
        model.autoInteract = true;
        model.interactive = true;
        model.anchor.set(0.5, 0.5);
        model.position.set(handle.x, handle.y);
        const scale = Math.min(
            720 / Math.max(model.internalModel.width, 1),
            540 / Math.max(model.internalModel.height, 1),
            1
        );
        model.scale.set(scale, scale);
        model.visible = handle.visible;
        const diagnostics = createDiagnostics(model);
        model.on('hit', (hitAreas) => {
            diagnostics.tapCount += 1;
            diagnostics.model.hitAreas = Array.from(new Set([
                ...diagnostics.model.hitAreas,
                ...hitAreas
            ])).sort();
        });
        return registerRuntime({
            handle,
            kind: 'live2d',
            model,
            diagnostics
        });
    } catch (error) {
        if (error instanceof MascotValidationError)
            throw error;
        return registerRuntime({
            handle: createHandle('fallback'),
            kind: 'fallback',
            diagnostics: createDiagnostics(undefined, error instanceof Error
                ? error.message
                : String(error))
        });
    }
}

export function getMascotModel(handle: MascotHandle): MascotDisplayModel | undefined {
    return modelRuntimes.get(handle.id)?.model;
}

export function isMascotFallback(handle: MascotHandle): boolean {
    return modelRuntimes.get(handle.id)?.kind === 'fallback';
}

export function getMascotDiagnostics(handle: MascotHandle): MascotDiagnostics | undefined {
    return modelRuntimes.get(handle.id)?.diagnostics;
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
    let motionStarted: boolean;
    try {
        motionStarted = await runtime.model.motion(cue.action, 0, 3);
        if (!motionStarted) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            motionStarted = await runtime.model.motion(cue.action, 0, 3);
        }
    } catch {
        motionStarted = false;
    }
    const diagnostic: MascotStateDiagnostic = {
        state: nextState,
        action: cue.action,
        parameters: { ...cue.parameters },
        motionStarted
    };
    runtime.diagnostics.stateMappings = [
        ...runtime.diagnostics.stateMappings.filter((item) => item.state !== nextState),
        diagnostic
    ];
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

interface Live2DCanvasDiagnostic {
    nonTransparentPixels: number;
    distinctColors: number;
}

interface Live2DInteractionDiagnostic {
    hitAreas: string[];
    tapCount: number;
}

export interface Live2DSmokeSnapshot {
    licenseNoticePresent: boolean;
    model: MascotDiagnostics['model'];
    canvas: Live2DCanvasDiagnostic;
    interaction: Live2DInteractionDiagnostic;
    stateMappings: MascotStateDiagnostic[];
}

interface Live2DSmokeApi {
    setState(state: MascotState): Promise<MascotStateDiagnostic>;
    interact(): Live2DInteractionDiagnostic;
    snapshot(): Live2DSmokeSnapshot;
}

declare global {
    interface Window {
        __desktopPetLive2DSmoke?: Live2DSmokeApi;
    }
}

export interface Live2DStageProps {
    modelPath: string;
    state: MascotState;
    performance?: PerformanceContext;
    onRenderModeChange?: (mode: 'live2d' | 'static-fallback') => void;
}

function isLive2DSmokeMode(): boolean {
    return typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).has('live2d-smoke');
}

function captureCanvasDiagnostic(canvas: HTMLCanvasElement): Live2DCanvasDiagnostic {
    const width = Math.min(canvas.width, 320);
    const height = Math.max(1, Math.round(width * canvas.height / Math.max(canvas.width, 1)));
    const sample = document.createElement('canvas');
    sample.width = width;
    sample.height = height;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (context === null)
        return { nonTransparentPixels: 0, distinctColors: 0 };
    context.drawImage(canvas, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let nonTransparentPixels = 0;
    const colors = new Set<string>();
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 8)
            continue;
        nonTransparentPixels += 1;
        colors.add(`${pixels[index] >> 4}:${pixels[index + 1] >> 4}:${pixels[index + 2] >> 4}`);
    }
    return {
        nonTransparentPixels,
        distinctColors: colors.size
    };
}

function installLive2DSmokeApi(
    app: Application,
    model: MascotDisplayModel,
    handle: MascotHandle
): void {
    const stateMappings: MascotStateDiagnostic[] = [];
    const findHeadPoint = (): { x: number; y: number } => {
        for (let y = 80; y <= 560; y += 24) {
            for (let x = 80; x <= 880; x += 24) {
                if (model.hitTest(x, y).includes('Head'))
                    return { x, y };
            }
        }
        throw new Error('Haru Head hit area was not reachable');
    };
    window.__desktopPetLive2DSmoke = {
        async setState(state) {
            await setMascotState(handle, state);
            const diagnostic = getMascotDiagnostics(handle)?.stateMappings.find(
                (item) => item.state === state
            );
            if (diagnostic === undefined)
                throw new Error(`Missing mascot diagnostic for ${state}`);
            stateMappings.push(diagnostic);
            return diagnostic;
        },
        interact() {
            const point = findHeadPoint();
            model.focus(point.x, point.y, true);
            model.tap(point.x, point.y);
            return {
                hitAreas: model.hitTest(point.x, point.y),
                tapCount: getMascotDiagnostics(handle)?.tapCount ?? 0
            };
        },
        snapshot() {
            const diagnostics = getMascotDiagnostics(handle);
            if (diagnostics === undefined)
                throw new Error('Mascot diagnostics are unavailable');
            return {
                licenseNoticePresent: document.body.textContent?.includes(
                    'This content uses sample data owned and copyrighted by Live2D Inc.'
                ) === true,
                model: diagnostics.model,
                canvas: captureCanvasDiagnostic(app.view),
                interaction: {
                    hitAreas: diagnostics.model.hitAreas,
                    tapCount: diagnostics.tapCount
                },
                stateMappings
            };
        }
    };
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
                container.dataset.renderError = getMascotDiagnostics(handle)
                    ?.fallbackReason ?? 'Live2D model unavailable';
                setRenderMode('static-fallback');
                return;
            }
            installPixiUnsafeEval({ systems });
            const app = new Application({
                width: 960,
                height: 640,
                antialias: true,
                autoStart: false,
                autoDensity: true,
                preserveDrawingBuffer: isLive2DSmokeMode(),
                transparent: true,
                resolution: Math.min(window.devicePixelRatio || 1, 2)
            });
            appRef.current = app;
            container.appendChild(app.view);
            app.stage.addChild(model as unknown as Parameters<typeof app.stage.addChild>[0]);
            app.ticker.add(() => {
                model.update(app.ticker.deltaMS);
            });
            app.render();
            if (isLive2DSmokeMode())
                installLive2DSmokeApi(app, model, handle);
            setRenderMode('live2d');
        })().catch((error: unknown) => {
            if (!disposed) {
                container.dataset.renderError = `Live2D stage initialization failed: ${error instanceof Error ? error.message : String(error)}`;
                setRenderMode('static-fallback');
            }
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
            if (isLive2DSmokeMode())
                delete window.__desktopPetLive2DSmoke;
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
                pointerEvents: 'auto',
                WebkitAppRegion: 'no-drag',
                width: '100%'
            } as React.CSSProperties & { WebkitAppRegion: 'no-drag' }}
        >
            {renderMode === 'static-fallback' ? <StaticMascot state={state} /> : null}
        </div>
    );
}
