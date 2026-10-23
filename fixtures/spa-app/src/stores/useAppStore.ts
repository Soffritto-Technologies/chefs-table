export const useAppStore = <T>(select: (state: { workspace: string }) => T): T => select({ workspace: 'Acme' });
