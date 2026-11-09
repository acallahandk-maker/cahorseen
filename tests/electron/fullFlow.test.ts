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
            retainedScreenshotBytes: 0
        },
        providerError: {
            code: 'rate-limited',
            message: 'Provider rate limit exceeded.'
        },
        memoryHeat: {
            sourceText: 'Hello',
            occurrenceCount: 2
        },
        quiz: {
            scheduledIntervalDays: 3,
            paused: true,
            pausedSelectionCount: 0
        },
        secret: {
            masked: '••••••••',
            hasApiKey: true,
            leaked: false,
            exposedSecretFields: []
        },
        pause: {
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        },
        resourcePressure: {
            reducedBeforeStatic: true
        }
    });
    expect(result.diagnostics?.persistedScreenshotFiles).toEqual([]);
    expect(result.diagnostics?.leakedProcessIds).toEqual([]);
    expect(result.diagnostics?.stdout).not.toContain(syntheticSecret);
    expect(result.diagnostics?.stderr).not.toContain(syntheticSecret);
}, 20_000);
