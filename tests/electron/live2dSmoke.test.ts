import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runElectronSmoke } from './harness';

const mocks = vi.hoisted(() => ({
    modelFrom: vi.fn(),
    registerTicker: vi.fn(),
    applicationDestroy: vi.fn(),
    tickerAdd: vi.fn(),
    tickerRemove: vi.fn()
}));

vi.mock('pixi-live2d-display/lib/cubism4', () => ({
    Live2DModel: {
        from: mocks.modelFrom,
        registerTicker: mocks.registerTicker
    }
}));

vi.mock('pixi.js', () => ({
    Application: class {
        destroy = mocks.applicationDestroy;
    },
    Ticker: class {}
}));

const {
    configureFrameTicker,
    loadMascotModel,
    mascotStateCues,
    setMascotState
} = await import('../../src/renderer/pet/Live2DStage');

const fixtureUrl = '/tests/fixtures/live2d/tiny.model3.json';
const fixturePath = fileURLToPath(new URL(
    '../fixtures/live2d/tiny.model3.json',
    import.meta.url
));

interface FakeModel {
    anchor: { set: ReturnType<typeof vi.fn> };
    position: { set: ReturnType<typeof vi.fn> };
    scale: { set: ReturnType<typeof vi.fn> };
    visible: boolean;
    autoUpdate: boolean;
    autoInteract: boolean;
    interactive: boolean;
    textures: unknown[];
    motion: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    tap: ReturnType<typeof vi.fn>;
    hitTest: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    internalModel: {
        width: number;
        height: number;
        hitAreas: Record<string, unknown>;
        motionManager: {
            definitions: Record<string, unknown>;
        };
        coreModel: {
            setParameterValueById: ReturnType<typeof vi.fn>;
            getParameterCount: ReturnType<typeof vi.fn>;
        };
        destroy: ReturnType<typeof vi.fn>;
    };
}

function createFakeModel(): FakeModel {
    return {
        anchor: { set: vi.fn() },
        position: { set: vi.fn() },
        scale: { set: vi.fn() },
        visible: true,
        autoUpdate: false,
        autoInteract: true,
        interactive: true,
        textures: [],
        motion: vi.fn().mockResolvedValue(true),
        update: vi.fn(),
        focus: vi.fn(),
        tap: vi.fn(),
        hitTest: vi.fn().mockReturnValue(['Head']),
        on: vi.fn(),
        destroy: vi.fn(),
        internalModel: {
            width: 100,
            height: 100,
            hitAreas: { Head: {}, Body: {} },
            motionManager: {
                definitions: {
                    Idle: [],
                    Listen: [],
                    Thinking: [],
                    Success: [],
                    Error: [],
                    Quiz: [],
                    Happy: [],
                    Sad: []
                }
            },
            coreModel: {
                setParameterValueById: vi.fn(),
                getParameterCount: vi.fn().mockReturnValue(8)
            },
            destroy: vi.fn()
        }
    };
}

function fixtureResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

interface MutableManifest {
    FileReferences: {
        [key: string]: unknown;
    };
}

function loadFixtureManifest(): MutableManifest {
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as MutableManifest;
}

interface Live2DAssetManifest {
    core: {
        archiveSha256: string;
        outputSha256: string;
    };
    model: {
        archiveSha256: string;
        sourceTreeSha256: string;
    };
}

const expectedStateCues = {
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
} as const;

beforeAll(() => {
    vi.stubGlobal('Live2DCubismCore', {});
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        fixtureResponse(JSON.parse(readFileSync(fixturePath, 'utf8')))
    ));
});

describe('Live2D mascot smoke', () => {
    it('provisions checksum-verified official Cubism runtime and full model assets', async () => {
        const lockPath = fileURLToPath(new URL(
            '../../config/live2d-assets.lock.json',
            import.meta.url
        ));
        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Live2DAssetManifest;

        expect(lock.core.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(lock.core.outputSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(lock.model.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(lock.model.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/);

        const provision = await new Promise<{ code: number | null; stderr: string }>(
            (resolve, reject) => {
                const child = spawn(process.execPath, [
                    'scripts/provision-live2d-assets.mjs',
                    '--verify'
                ], {
                    cwd: fileURLToPath(new URL('../..', import.meta.url)),
                    stdio: ['ignore', 'ignore', 'pipe']
                });
                let stderr = '';
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk: string) => {
                    stderr += chunk;
                });
                child.once('error', reject);
                child.once('close', (code) => resolve({ code, stderr }));
            }
        );

        expect(provision.stderr).toBe('');
        expect(provision.code).toBe(0);
    });

    it('loads and validates the tiny synthetic model fixture', async () => {
        const model = createFakeModel();
        mocks.modelFrom.mockResolvedValue(model);

        const handle = await loadMascotModel(fixtureUrl);

        expect(handle).toMatchObject({
            x: 480,
            y: 320,
            visible: true
        });
        expect(handle.id).toMatch(/^mascot-/);
        expect(fetch).toHaveBeenCalledWith(fixtureUrl, expect.anything());
        expect(mocks.modelFrom).toHaveBeenCalledWith(fixtureUrl, {
            autoUpdate: false,
            autoInteract: true
        });
        expect(model.autoInteract).toBe(true);
        expect(model.interactive).toBe(true);
    });

    it.each([
        'thinking',
        'success',
        'error',
        'quizzing',
        'happy',
        'sad'
    ] as const)('maps %s to deterministic parameters and action layer', async (state) => {
        const model = createFakeModel();
        mocks.modelFrom.mockResolvedValue(model);
        const handle = await loadMascotModel(fixtureUrl);
        const cue = expectedStateCues[state];

        expect(mascotStateCues[state]).toEqual(cue);

        await setMascotState(handle, state);

        expect(model.motion).toHaveBeenCalledWith(cue.action, 0, 3);
        expect(model.internalModel.coreModel.setParameterValueById.mock.calls)
            .toEqual(Object.entries(cue.parameters).map(([parameterId, value]) => [
                parameterId,
                value
            ]));
    });

    it('falls back to the static mascot when Cubism model loading fails', async () => {
        mocks.modelFrom.mockRejectedValue(new Error('Cubism runtime unavailable'));

        const handle = await loadMascotModel(fixtureUrl);

        expect(handle.id).toMatch(/^fallback-/);
        await expect(setMascotState(handle, 'sad')).resolves.toBeUndefined();
    });

    it('rejects remote and escaping model references before loading', async () => {
        await expect(loadMascotModel('https://example.test/tiny.model3.json'))
            .rejects.toThrow('Model path must be local');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fixtureResponse({
            Version: { Major: 3, Minor: 0 },
            FileReferences: {
                Moc: '../outside.moc3',
                Textures: ['tiny.png']
            }
        })));

        await expect(loadMascotModel(fixtureUrl))
            .rejects.toThrow('Model reference escapes the model directory');

        await expect(loadMascotModel('/live2d/%2e%2e/outside.model3.json'))
            .rejects.toThrow('Model path must stay inside the model directory');
    });

    it.each([
        { name: 'moc', field: 'Moc', value: '../outside.moc3' },
        { name: 'textures', field: 'Textures', value: '../outside.png' },
        { name: 'physics', field: 'Physics', value: 'https://example.test/outside.physics3.json' },
        { name: 'pose', field: 'Pose', value: '%2e%2e/outside.pose3.json' },
        { name: 'display info', field: 'DisplayInfo', value: '/outside.cdi3.json' },
        { name: 'user data', field: 'UserData', value: '../outside.userdata3.json' },
        { name: 'expressions', field: 'Expressions', value: '../../outside.exp3.json' },
        { name: 'motions', field: 'Motions', value: 'file:outside.motion3.json' },
        { name: 'sounds', field: 'Sounds', value: 'https://example.test/outside.wav' }
    ])('rejects unsafe $name manifest references', async ({ field, value }) => {
        const manifest = loadFixtureManifest();
        if (field === 'Textures')
            manifest.FileReferences.Textures = [value];
        else if (field === 'Expressions')
            (manifest.FileReferences.Expressions as Array<{ File: string }>)[0].File = value;
        else if (field === 'Motions')
            (manifest.FileReferences.Motions as Record<string, Array<{ File: string }>>)
                .Thinking[0].File = value;
        else if (field === 'Sounds')
            (manifest.FileReferences.Motions as Record<string, Array<{ Sound?: string }>>)
                .Sad[0].Sound = value;
        else
            manifest.FileReferences[field] = value;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fixtureResponse(manifest)));

        await expect(loadMascotModel(fixtureUrl))
            .rejects.toThrow(/(?:local|relative|escapes|encoding)/);
    });

    it('rejects model manifests missing deterministic action layers', async () => {
        const manifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
            FileReferences: {
                Motions: Record<string, unknown>;
            };
        };
        delete manifest.FileReferences.Motions.Listen;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fixtureResponse(manifest)));

        await expect(loadMascotModel(fixtureUrl))
            .rejects.toThrow('Model manifest is missing motion group Listen');
    });

    it('throttles the ticker and pauses hidden or suppressed loops', () => {
        const ticker = {
            maxFPS: 0,
            start: vi.fn(),
            stop: vi.fn()
        };

        configureFrameTicker(ticker, { reason: 'normal' });
        expect(ticker).toMatchObject({ maxFPS: 30 });
        expect(ticker.start).toHaveBeenCalledTimes(1);

        configureFrameTicker(ticker, { hidden: true });
        expect(ticker).toMatchObject({ maxFPS: 10 });
        expect(ticker.stop).toHaveBeenCalledTimes(1);

        configureFrameTicker(ticker, { reason: 'normal', suppressed: true });
        expect(ticker).toMatchObject({ maxFPS: 30 });
        expect(ticker.stop).toHaveBeenCalledTimes(2);
    });

    it('boots the Electron pet with a real interactive Cubism model', async () => {
        const result = await runElectronSmoke('live2d-real');
        const live2d = (result.payload as {
            live2D?: {
                licenseNoticePresent: boolean;
                model: {
                    autoInteract: boolean;
                    parameterCount: number;
                    textureCount: number;
                    motionGroupCount: number;
                    hitAreas: string[];
                };
                canvas: {
                    nonTransparentPixels: number;
                    distinctColors: number;
                };
                interaction: {
                    hitAreas: string[];
                    tapCount: number;
                };
                stateMappings: Array<{
                    state: string;
                    action: string;
                    parameters: Record<string, number>;
                    motionStarted: boolean;
                }>;
            };
        }).live2D;

        expect(result.windowCount).toBe(1);
        expect((result.payload as { mascotRenderMode?: unknown }).mascotRenderMode)
            .toBe('live2d');
        expect(live2d).toBeDefined();
        expect(live2d?.licenseNoticePresent).toBe(true);
        expect(live2d?.model.autoInteract).toBe(true);
        expect(live2d?.model.parameterCount).toBeGreaterThanOrEqual(30);
        expect(live2d?.model.textureCount).toBeGreaterThanOrEqual(2);
        expect(live2d?.model.motionGroupCount).toBeGreaterThanOrEqual(8);
        expect(live2d?.model.hitAreas).toContain('Head');
        expect(live2d?.canvas.nonTransparentPixels).toBeGreaterThan(1_000);
        expect(live2d?.canvas.distinctColors).toBeGreaterThan(16);
        expect(live2d?.interaction.hitAreas).toContain('Head');
        expect(live2d?.interaction.tapCount).toBeGreaterThan(0);
        expect(live2d?.stateMappings).toEqual(
            Object.entries(expectedStateCues).map(([state, cue]) => ({
                state,
                action: cue.action,
                parameters: cue.parameters,
                motionStarted: true
            }))
        );
    }, 20_000);
});
