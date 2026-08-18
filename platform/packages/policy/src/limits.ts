// Rolling-window boundary calculations. All bounds are ISO-string
// half-open intervals [start, end) with `end` = now.

export const windowStart = (now: Date, days: number): string => {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString();
};

export const dayStart = (now: Date): string => windowStart(now, 1);
export const weekStart = (now: Date): string => windowStart(now, 7);
export const monthStart = (now: Date): string => windowStart(now, 30);
