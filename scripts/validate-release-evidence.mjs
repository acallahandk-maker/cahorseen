import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_PATTERNS = [
    /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/gi,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:xox[baprs]|ASIA)[A-Za-z0-9-]{16,}\b/gi,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/gi,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9_+=/-]{12,})["']?/gi,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
];
const TEXT_EXTENSIONS = new Set([
    '.cjs', '.css', '.csv', '.env', '.html', '.ini', '.js', '.json', '.jsonl',
    '.log', '.md', '.mjs', '.ps1', '.sh', '.toml', '.ts', '.tsx', '.txt',
    '.xml', '.yaml', '.yml'
]);
const IGNORED_DIRECTORIES = new Set([
    '.git',
    'coverage',
    'dist',
    'node_modules',
    'out'
]);
const SAFE_SECRET_VALUES = new Set([
    'nonEmptyString',
    'positiveInteger',
    'sk-synthetic-test-only'
]);
const SAFE_SECRET_VALUE_PREFIXES = ['placeholder-'];
const APPROVED_RUNTIME_LICENSES = new Set([
    'Apache-2.0',
    'BlueOak-1.0.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'CC0-1.0',
    'ISC',
    'MIT',
    'MIT-0',
    'Python-2.0'
]);
const APPROVED_DEVELOPMENT_LICENSES = new Set([
    ...APPROVED_RUNTIME_LICENSES,
    '0BSD',
    'CC-BY-4.0',
    'MPL-2.0',
    'WTFPL',
    'WTFPL OR ISC',
    'MIT OR CC0-1.0',
    'WTFPL OR MIT'
]);

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return extension === '' || TEXT_EXTENSIONS.has(extension);
}

function scanFile(filePath, relativePath) {
    const content = readFileSync(filePath, 'utf8');
    if (content.includes('\u0000'))
        return;
    for (const line of content.split(/\r?\n/)) {
        for (const pattern of SECRET_PATTERNS) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(line)) !== null) {
                const value = match[1] ?? match[0];
                if (isSafeSecretValue(value))
                    continue;
                throw new Error(`Potential secret found in ${relativePath}; value not reported`);
            }
        }
    }
}

function isSafeSecretValue(value) {
    return SAFE_SECRET_VALUES.has(value)
        || SAFE_SECRET_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function scanSecrets(root) {
    const scan = (directory) => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            throw new Error(`Secret scan could not read ${directory}`);
        }
        for (const entry of entries) {
            if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))
                continue;
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                scan(entryPath);
                continue;
            }
            if (!entry.isFile() || !isTextFile(entryPath))
                continue;
            scanFile(entryPath, path.relative(root, entryPath));
        }
    };
    scan(root);
    return true;
}

function readJson(filePath, label) {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new Error(`${label} is missing or invalid`);
    }
}

function normalizeLicense(license) {
    return license.trim().replace(/^\(/, '').replace(/\)$/, '');
}

function isApprovedLicense(license, runtime) {
    const normalized = normalizeLicense(license);
    const choices = normalized.split(/\s+OR\s+/i).map((choice) => (
        choice.trim().replace(/^\(/, '').replace(/\)$/, '')
    ));
    const approved = runtime
        ? APPROVED_RUNTIME_LICENSES
        : APPROVED_DEVELOPMENT_LICENSES;
    return choices.length > 0 && choices.every((choice) => approved.has(choice));
}

function summariesEqual(left, right) {
    const selectSummary = (value) => ({
        packageCount: value.packageCount,
        runtimePackageCount: value.runtimePackageCount,
        licenseCounts: value.licenseCounts ?? {}
    });
    const leftSummary = selectSummary(left);
    const rightSummary = selectSummary(right);
    return JSON.stringify({
        ...leftSummary,
        licenseCounts: Object.fromEntries(
            Object.entries(leftSummary.licenseCounts).sort(([a], [b]) => a.localeCompare(b))
        )
    }) === JSON.stringify({
        ...rightSummary,
        licenseCounts: Object.fromEntries(
            Object.entries(rightSummary.licenseCounts).sort(([a], [b]) => a.localeCompare(b))
        )
    });
}

export function validateDependencyLicenses(options) {
    const query = readJson(options.queryPath, 'npm dependency query');
    if (!Array.isArray(query) || query.length === 0)
        throw new Error('npm dependency query is empty');
    let rootPackage = query[0];
    try {
        if (statSync(options.packageJsonPath).isFile())
            rootPackage = readJson(options.packageJsonPath, 'package.json');
    } catch (error) {
        if (
            !isRecord(error)
            || error.code !== 'ENOENT'
        )
            throw error;
    }
    const packages = new Map();
    for (const dependency of query) {
        if (
            !isRecord(dependency)
            || typeof dependency.name !== 'string'
            || typeof dependency.version !== 'string'
            || typeof dependency.license !== 'string'
            || dependency.license.trim().length === 0
        )
            throw new Error('Dependency license metadata is incomplete');
        packages.set(`${dependency.name}@${dependency.version}`, dependency);
    }
    const thirdParty = [...packages.values()].filter((dependency) => (
        dependency.name !== rootPackage.name
        || dependency.version !== rootPackage.version
    ));
    const licenseCounts = {};
    let runtimePackageCount = 0;
    for (const dependency of thirdParty) {
        const runtime = dependency.dev !== true;
        if (runtime)
            runtimePackageCount += 1;
        if (!isApprovedLicense(dependency.license, runtime))
            throw new Error(`Dependency license is not approved: ${dependency.name}@${dependency.version}`);
        licenseCounts[dependency.license] = (licenseCounts[dependency.license] ?? 0) + 1;
    }
    const summary = {
        packageCount: thirdParty.length,
        runtimePackageCount,
        licenseCounts: Object.fromEntries(
            Object.entries(licenseCounts).sort(([left], [right]) => left.localeCompare(right))
        )
    };
    if (existsSync(options.reviewPath)) {
        const recordedReview = readJson(options.reviewPath, 'dependency/license review');
        if (!summariesEqual(recordedReview, summary))
            throw new Error('Dependency/license review does not match the current package graph');
    }
    const checklist = readFileSync(options.checklistPath, 'utf8');
    const marker = checklist.match(
        /<!--\s*dependency-license-summary\s+(\{[\s\S]*?\})\s*-->/i
    );
    if (marker === null)
        throw new Error('Dependency/license checklist summary is missing');
    let checklistSummary;
    try {
        checklistSummary = JSON.parse(marker[1]);
    } catch {
        throw new Error('Dependency/license checklist summary is invalid');
    }
    if (!summariesEqual(checklistSummary, summary))
        throw new Error('Dependency/license checklist counts do not match the current package graph');
    writeFileSync(options.reviewPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: "npm query '*'",
        ...summary,
        packages: thirdParty
            .map((dependency) => ({
                name: dependency.name,
                version: dependency.version,
                license: dependency.license,
                runtime: dependency.dev !== true
            }))
            .sort((left, right) => (
                left.name.localeCompare(right.name)
                || left.version.localeCompare(right.version)
            ))
    }, null, 2)}\n`, 'utf8');
    const generatedReview = readJson(options.reviewPath, 'generated dependency/license review');
    if (!summariesEqual(generatedReview, summary))
        throw new Error('Generated dependency/license review does not match the current package graph');
    return summary;
}

export function validateProfileFreshness(profile, now = new Date()) {
    if (
        profile.measurementKind !== 'electron-profile-with-accelerated-workload-cycles'
        && profile.measurementKind !== 'electron-real-wall-clock-profile'
    )
        throw new Error('Performance evidence has an unsupported measurement kind');
    const generatedAt = new Date(profile.generatedAt);
    const ageMs = now.getTime() - generatedAt.getTime();
    if (!Number.isFinite(generatedAt.getTime()))
        throw new Error('Performance evidence has an invalid generation time');
    if (ageMs > 15 * 60 * 1000 || ageMs < -2 * 60 * 1000)
        throw new Error('Stale performance evidence must be regenerated');
    return true;
}

export function validatePerformanceEvidence(profile) {
    if (profile.evaluation?.pass !== true)
        throw new Error('Performance measurements exceed product targets');
    if (profile.interactionLatencyBasis !== 'input-event-to-rendered-frame')
        throw new Error('Performance evidence lacks input-event-to-rendered-frame latency evidence');
    if (profile.activeCpuBasis !== 'electron-app-metrics-active-work-window')
        throw new Error('Performance evidence lacks active-work CPU evidence');
    if (profile.screenshotPeakBasis !== 'electron-app-metrics-private-bytes-fine-sampled')
        throw new Error('Performance evidence lacks fine-sampled screenshot memory evidence');
    const measurement = profile.measurement;
    if (
        !isRecord(measurement)
        || !Number.isFinite(measurement.idleCpuPercent)
        || !Number.isFinite(measurement.activeCpuPercent)
        || !Number.isFinite(measurement.normalPrivateBytes)
        || !Number.isFinite(measurement.peakPrivateBytes)
        || !Number.isFinite(measurement.interactionLatencyMs)
        || measurement.idleCpuPercent >= 1
        || measurement.activeCpuPercent >= 15
        || measurement.normalPrivateBytes >= 300 * 1024 * 1024
        || measurement.peakPrivateBytes >= 450 * 1024 * 1024
        || measurement.interactionLatencyMs >= 200
    )
        throw new Error('Performance evidence does not satisfy the product targets');
    if (
        !Number.isFinite(profile.activeWindowMs)
        || profile.activeWindowMs <= 0
        || !Number.isInteger(profile.interactionSamples)
        || profile.interactionSamples < 1
        || !Number.isInteger(profile.screenshotCaptureCount)
        || profile.screenshotCaptureCount < 1
        || profile.screenshotPeakPrivateBytes !== measurement.peakPrivateBytes
    )
        throw new Error('Performance evidence lacks production workload instrumentation');
    const drift = profile.idleDrift;
    if (profile.measurementKind === 'electron-profile-with-accelerated-workload-cycles') {
        if (
            profile.idleDriftBasis !== 'electron-app-metrics-private-bytes-executed-workload-cycles'
            || drift?.measurementKind !== 'accelerated-workload-cycles'
            || drift.executedCycles !== 480
            || drift.declaredCycles !== 480
            || drift.sampleCount !== 480
            || drift.equivalentHours !== 8
            || drift.minutesPerCycle !== 1
            || !Number.isFinite(drift.wallClockDurationMs)
            || drift.wallClockDurationMs <= 0
            || Object.prototype.hasOwnProperty.call(drift, 'wallClockHoursMeasured')
        )
            throw new Error('Accelerated performance evidence must contain 480 executed workload cycles');
    } else {
        if (
            profile.idleDriftBasis !== 'electron-app-metrics-private-bytes-real-wall-clock'
            || drift?.measurementKind !== 'real-wall-clock'
            || !Number.isFinite(drift.measuredHours)
            || drift.measuredHours < 8
            || !Number.isFinite(drift.wallClockDurationMs)
            || drift.wallClockDurationMs < drift.measuredHours * 60 * 60 * 1000
        )
            throw new Error('Real-wall-clock performance evidence must measure eight hours');
    }
    if (drift.pass !== true)
        throw new Error('Idle memory drift exceeds the 25 MB target');
    return true;
}

function argumentValue(argumentsList, name) {
    const index = argumentsList.indexOf(name);
    return index === -1 ? undefined : argumentsList[index + 1];
}

function runCli() {
    const argumentsList = process.argv.slice(2);
    const root = argumentValue(argumentsList, '--root');
    const queryPath = argumentValue(argumentsList, '--query');
    const reviewPath = argumentValue(argumentsList, '--review');
    const checklistPath = argumentValue(argumentsList, '--checklist');
    const packageJsonPath = argumentValue(argumentsList, '--package');
    const profilePath = argumentValue(argumentsList, '--profile');
    if (
        root === undefined
        || queryPath === undefined
        || reviewPath === undefined
        || checklistPath === undefined
        || packageJsonPath === undefined
        || profilePath === undefined
    )
        throw new Error('Release evidence validation arguments are incomplete');
    scanSecrets(root);
    const profile = readJson(profilePath, 'performance profile');
    validateProfileFreshness(profile);
    validatePerformanceEvidence(profile);
    validateDependencyLicenses({
        root,
        queryPath,
        reviewPath,
        checklistPath,
        packageJsonPath
    });
}

if (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href
)
    runCli();
