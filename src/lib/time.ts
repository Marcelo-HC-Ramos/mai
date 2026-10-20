export const DAY = 86_400_000;
export const iso = (d: Date) => d.toISOString();
export const nowIso = () => new Date().toISOString();
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const startOfDayUTC = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const toDate = (v: string | Date | null | undefined) => (v ? (v instanceof Date ? v : new Date(v)) : null);
