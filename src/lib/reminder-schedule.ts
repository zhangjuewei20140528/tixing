export function nextFutureOccurrence(scheduledAt: Date, repeatRule: string, after = new Date()) {
  if (repeatRule.startsWith("monthly:")) {
    if (scheduledAt > after) return new Date(scheduledAt);
    const value = repeatRule.slice("monthly:".length);
    const desiredDay = value === "last" ? null : Number(value);
    if (desiredDay !== null && (!Number.isInteger(desiredDay) || desiredDay < 1 || desiredDay > 31)) return null;
    const occurrence = (year: number, month: number) => {
      const candidate = new Date(scheduledAt);
      candidate.setFullYear(year, month, 1);
      const lastDay = new Date(year, month + 1, 0).getDate();
      candidate.setDate(desiredDay === null ? lastDay : Math.min(desiredDay, lastDay));
      return candidate;
    };
    let candidate = occurrence(after.getFullYear(), after.getMonth());
    if (candidate <= after) candidate = occurrence(after.getFullYear(), after.getMonth() + 1);
    return candidate;
  }
  if (repeatRule === "weekdays") {
    const day = 24 * 60 * 60_000;
    let candidate = new Date(scheduledAt);
    if (candidate <= after) {
      const steps = Math.floor((after.getTime() - candidate.getTime()) / day) + 1;
      candidate = new Date(candidate.getTime() + steps * day);
    }
    while (candidate.getDay() === 0 || candidate.getDay() === 6) candidate = new Date(candidate.getTime() + day);
    return candidate;
  }
  const interval = repeatRule === "daily" ? 24 * 60 * 60_000 : repeatRule === "weekly" ? 7 * 24 * 60 * 60_000 : null;
  if (!interval) return null;
  if (scheduledAt > after) return new Date(scheduledAt);
  const elapsed = after.getTime() - scheduledAt.getTime();
  const steps = Math.floor(elapsed / interval) + 1;
  return new Date(scheduledAt.getTime() + steps * interval);
}
