export const FETCH_BLOCKED_PORTS: ReadonlySet<number>;
export function freePort(pick?: () => Promise<number>): Promise<number>;
