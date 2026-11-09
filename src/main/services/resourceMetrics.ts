import { app } from 'electron';
import type { ResourcePressureMetrics } from '../../shared/contracts';

export function getElectronPrivateBytes(): number {
    return app.getAppMetrics().reduce(
        (total, metric) => total + (metric.memory.privateBytes ?? 0) * 1024,
        0
    );
}

export function getElectronResourcePressureMetrics(): ResourcePressureMetrics {
    return {
        privateBytes: getElectronPrivateBytes(),
        basis: 'electron-app-metrics-private-bytes'
    };
}
