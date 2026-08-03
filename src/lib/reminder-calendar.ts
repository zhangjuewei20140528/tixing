export type CalendarReminderRule = {
  scheduledAt: string;
  repeatRule: string;
  repeatUntil?: string | null;
};

function sameLocalDate(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function reminderOccurrenceOnDate(reminder: CalendarReminderRule, day: Date) {
  const start = new Date(reminder.scheduledAt);
  if (Number.isNaN(start.getTime())) return null;

  const occurrence = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    start.getHours(),
    start.getMinutes(),
    start.getSeconds(),
    start.getMilliseconds(),
  );
  if (occurrence < start) return null;

  const repeatUntil = reminder.repeatUntil ? new Date(reminder.repeatUntil) : null;
  if (repeatUntil && occurrence > repeatUntil) return null;

  if (reminder.repeatRule === "once") return sameLocalDate(start, occurrence) ? occurrence : null;
  if (reminder.repeatRule === "daily") return occurrence;
  if (reminder.repeatRule === "weekdays") return occurrence.getDay() >= 1 && occurrence.getDay() <= 5 ? occurrence : null;
  if (reminder.repeatRule === "weekly") return occurrence.getDay() === start.getDay() ? occurrence : null;

  const lastDay = new Date(occurrence.getFullYear(), occurrence.getMonth() + 1, 0).getDate();
  if (reminder.repeatRule === "monthly:last") return occurrence.getDate() === lastDay ? occurrence : null;
  if (reminder.repeatRule.startsWith("monthly:")) {
    const intendedDay = Number(reminder.repeatRule.slice("monthly:".length));
    return occurrence.getDate() === Math.min(intendedDay, lastDay) ? occurrence : null;
  }
  return null;
}
