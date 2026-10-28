import { contextBridge, ipcRenderer } from 'electron';
import { z } from 'zod';

const pingChannel = 'desktop-pet:ping';
const pingResponseSchema = z.object({
    version: z.string().min(1)
});

export interface DesktopPetApi {
    ping: () => Promise<{ version: string }>;
}

const desktopPetApi: DesktopPetApi = {
    ping: async () => pingResponseSchema.parse(await ipcRenderer.invoke(pingChannel))
};

contextBridge.exposeInMainWorld('desktopPet', desktopPetApi);
