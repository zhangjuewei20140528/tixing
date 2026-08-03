import { and, count, eq, inArray } from "drizzle-orm";
import { effectiveReminderLimit, reminderLimitMessage, type VipType } from "@/lib/membership";
import { db } from "./db";
import { reminders } from "./db/schema";

export type ReminderQuotaUser = {
  id: string;
  vipType: VipType;
  vipExpiresAt: Date | string | null;
  reminderLimitOverride?: number | null;
};

export class ReminderLimitError extends Error {
  readonly code = "REMINDER_LIMIT_REACHED";
  readonly limit: number;
  readonly activeCount: number;

  constructor(user: ReminderQuotaUser, activeCount: number, limit: number) {
    super(reminderLimitMessage(user, limit));
    this.limit = limit;
    this.activeCount = activeCount;
  }
}

export async function activeReminderCount(userId: string) {
  const [row] = await db.select({ value: count() }).from(reminders).where(and(
    eq(reminders.userId, userId),
    inArray(reminders.status, ["upcoming", "paused"]),
  ));
  return Number(row?.value || 0);
}

export async function reminderQuota(user: ReminderQuotaUser) {
  const activeCount = await activeReminderCount(user.id);
  const limit = effectiveReminderLimit(user);
  return { activeCount, limit, remaining: Math.max(0, limit - activeCount) };
}

export async function assertReminderCapacity(user: ReminderQuotaUser, requested = 1) {
  const quota = await reminderQuota(user);
  if (requested < 1 || quota.activeCount + requested > quota.limit) {
    throw new ReminderLimitError(user, quota.activeCount, quota.limit);
  }
  return quota;
}
