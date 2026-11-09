import { expect, it } from 'vitest';
import { runElectronSmoke } from './harness';

it('exercises translation, learning, privacy, pause, and shutdown gates end to end', async () => {
    const syntheticSecret = ['sk', 'synthetic', 'full', 'flow', 'secret'].join('-');
    const result = await runElectronSmoke('full-flow', {
        includeDiagnostics: true
    });

    expect(result.payload.fullFlow).toMatchObject({
        selection: {
            sourceText: 'Hello',
            translatedText: 'Bonjour',
            memoryStatus: 'recorded'
        },
        screenshot: {
            translatedText: 'Image text',
            sourceText: 'Image text',
            captureCount: 1,
            retainedScreenshotBytes: 0,
            activeCaptureCount: 0,
            captureBufferCleared: true
        },
        providerError: {
            code: 'rate-limited',
            message: 'Provider rate limit exceeded.'
        },
        memoryHeat: {
            sourceText: 'Hello',
            occurrenceCount: 2,
            entryCount: 5
        },
        quiz: {
            scheduledIntervalDays: 3,
            selectedBeforePause: 1,
            selectedWhilePaused: 0
        },
        secret: {
            masked: '••••••••',
            hasApiKey: true,
            leaked: false,
            exposedSecretFields: []
        },
        pause: {
            before: {
                reason: 'normal',
                frameRate: 30,
                suppressed: false
            },
            paused: {
                reason: 'paused',
                frameRate: 0,
                suppressed: true
            },
            afterResume: {
                reason: 'normal',
                frameRate: 30,
                suppressed: false
            }
        },
        resourcePressure: {
            reducedObserved: true,
            staticObserved: true,
            recoveredRenderMode: 'live2d',
            privateMemoryBasis: 'electron-app-metrics-private-bytes',
            interactionLatencyBasis: 'input-event-to-rendered-frame'
        }
    });
    expect(result.diagnostics?.persistedScreenshotFiles).toEqual([]);
    expect(result.diagnostics?.leakedProcessIds).toEqual([]);
    expect(result.diagnostics?.stdout).not.toContain(syntheticSecret);
    expect(result.diagnostics?.stderr).not.toContain(syntheticSecret);
}, 40_000);
