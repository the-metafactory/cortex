export const junkIdentity = (account: string | undefined, id: string): string => JSON.stringify([account ?? null, id]);
