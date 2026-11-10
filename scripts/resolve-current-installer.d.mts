export function resolveCurrentInstaller(options: {
    projectRoot: string;
    builtAfterMs: number;
}): Promise<{
    path: string;
    sizeBytes: number;
    sha256: string;
    modifiedAtUtc: string;
}>;
