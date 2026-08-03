import assert from "node:assert/strict";
import test from "node:test";
import { reminderOccurrenceOnDate } from "./reminder-calendar";

const day = (year: number, month: number, date: number) => new Date(year, month, date, 12);

test("expands daily reminders across calendar dates", () => {
  const reminder = { scheduledAt: new Date(2026, 6, 31, 7).toISOString(), repeatRule: "daily" };
  assert.equal(reminderOccurrenceOnDate(reminder, day(2026, 6, 30)), null);
  assert.equal(reminderOccurrenceOnDate(reminder, day(2026, 6, 31))?.getHours(), 7);
  assert.equal(reminderOccurrenceOnDate(reminder, day(2026, 7, 1))?.getHours(), 7);
  assert.equal(reminderOccurrenceOnDate(reminder, day(2026, 7, 20))?.getHours(), 7);
});

test("respects weekday, weekly, monthly, and finite repeat rules", () => {
  const weekdays = { scheduledAt: new Date(2026, 6, 31, 9).toISOString(), repeatRule: "weekdays" };
  assert.ok(reminderOccurrenceOnDate(weekdays, day(2026, 7, 3)));
  assert.equal(reminderOccurrenceOnDate(weekdays, day(2026, 7, 2)), null);

  const weekly = { scheduledAt: new Date(2026, 6, 31, 9).toISOString(), repeatRule: "weekly" };
  assert.ok(reminderOccurrenceOnDate(weekly, day(2026, 7, 7)));
  assert.equal(reminderOccurrenceOnDate(weekly, day(2026, 7, 8)), null);

  const monthly = { scheduledAt: new Date(2027, 0, 31, 9).toISOString(), repeatRule: "monthly:31" };
  assert.ok(reminderOccurrenceOnDate(monthly, day(2027, 1, 28)));

  const finite = {
    scheduledAt: new Date(2026, 6, 31, 7).toISOString(),
    repeatRule: "daily",
    repeatUntil: new Date(2026, 7, 2, 7).toISOString(),
  };
  assert.ok(reminderOccurrenceOnDate(finite, day(2026, 7, 2)));
  assert.equal(reminderOccurrenceOnDate(finite, day(2026, 7, 3)), null);
});
