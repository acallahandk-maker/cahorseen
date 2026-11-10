'use strict';

async function main() {
    const { app, nativeImage } = await import('electron');
    const sourceDataUrl = process.argv[2] ?? '';
    const sourceDataUrlPrefix = 'data:image/png;base64,';
    const fail = (message) => {
        process.stderr.write(`${message}\n`);
        app.exit(1);
    };

    if (!sourceDataUrl.startsWith(sourceDataUrlPrefix)) {
        fail('Vision probe decoder expected a PNG data URL.');
        return;
    }

    app.disableHardwareAcceleration();
    await app.whenReady();
    try {
        const image = nativeImage.createFromDataURL(sourceDataUrl);
        const size = image.getSize();
        const bitmap = image.toBitmap();
        const png = image.toPNG();
        const decodedDataUrl = image.toDataURL();
        const redecoded = nativeImage.createFromBuffer(png);
        const decodedDataUrlPrefix = `${decodedDataUrl.split(',', 1)[0]},`;

        if (
            image.isEmpty()
            || size.width !== 1
            || size.height !== 1
            || bitmap.byteLength === 0
            || png.byteLength === 0
            || redecoded.isEmpty()
            || decodedDataUrlPrefix !== sourceDataUrlPrefix
        ) {
            fail('Vision probe PNG could not be decoded as a non-empty 1x1 PNG bitmap by Electron nativeImage.');
            return;
        }

        process.stdout.write(JSON.stringify({
            width: size.width,
            height: size.height,
            isEmpty: image.isEmpty(),
            bitmapByteLength: bitmap.byteLength,
            pngByteLength: png.byteLength,
            sourceDataUrlPrefix,
            decodedDataUrlPrefix
        }));
        app.exit(0);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`Vision probe PNG could not be decoded by Electron nativeImage: ${message}`);
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Electron nativeImage decoder failed to initialize: ${message}\n`);
    process.exitCode = 1;
});
