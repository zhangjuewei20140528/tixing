import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "./db";
import { deliveryAttempts, inboundCommandReceipts, reminders, serviceHeartbeats, wechatBindings } from "./db/schema";
import { finalizeDeliveredOccurrence } from "./delivery";
import { scheduleReminder } from "./queue";

type SchedulerState = { started: boolean; lastReceiptCleanupAt?: number };
const globalForScheduler = globalThis as unknown as { schedulerState?: SchedulerState };
const state = globalForScheduler.schedulerState ?? { started: false };
if (process.env.NODE_ENV !== "production") globalForScheduler.schedulerState = state;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconcileReminderJobs() {
  const now = new Date();
  const precisionWindowEnd = new Date(now.getTime() + 5 * 60_000);
  const rows = await db.select({ id: reminders.id, scheduledAt: reminders.scheduledAt }).from(reminders)
    .innerJoin(wechatBindings, and(eq(wechatBindings.userId, reminders.userId), eq(wechatBindings.status, "active")))
    .leftJoin(deliveryAttempts, and(
      eq(deliveryAttempts.reminderId, reminders.id),
      eq(deliveryAttempts.scheduledAt, reminders.scheduledAt),
    ))
    .where(and(
      eq(reminders.status, "upcoming"),
      isNull(deliveryAttempts.id),
      or(isNull(reminders.queueJobId), lte(reminders.scheduledAt, precisionWindowEnd)),
    ))
    .limit(500);

  for (const reminder of rows) {
    const startAfter = reminder.scheduledAt > now ? reminder.scheduledAt : now;
    const jobId = await scheduleReminder(reminder.id, startAfter, reminder.scheduledAt);
    if (jobId) await db.update(reminders).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(reminders.id, reminder.id));
  }
  return rows.length;
}

export async function reconcileDeliveredOccurrences() {
  const rows = await db.select({ reminderId: reminders.id, occurrenceAt: deliveryAttempts.scheduledAt })
    .from(reminders)
    .innerJoin(deliveryAttempts, and(
      eq(deliveryAttempts.reminderId, reminders.id),
      eq(deliveryAttempts.status, "sent"),
      eq(deliveryAttempts.scheduledAt, reminders.scheduledAt),
    ))
    .where(eq(reminders.status, "upcoming"))
    .limit(500);
  for (const row of rows) await finalizeDeliveredOccurrence(row.reminderId, row.occurrenceAt);
  return rows.length;
}

async function cleanupOldCommandReceipts() {
  const now = Date.now();
  if (state.lastReceiptCleanupAt && now - state.lastReceiptCleanupAt < 24 * 60 * 60_000) return;
  const cutoff = new Date(now - 180 * 24 * 60 * 60_000);
  await db.delete(inboundCommandReceipts).where(lt(inboundCommandReceipts.createdAt, cutoff));
  state.lastReceiptCleanupAt = now;
}

async function maintenanceLoop() {
  while (state.started) {
    try {
      await db.insert(serviceHeartbeats).values({ service: "worker", lastSeenAt: new Date(), details: { component: "scheduler" } }).onConflictDoUpdate({
        target: serviceHeartbeats.service,
        set: { lastSeenAt: new Date(), details: { component: "scheduler" } },
      });
      await reconcileDeliveredOccurrences();
      await reconcileReminderJobs();
      await cleanupOldCommandReceipts();
    } catch (error) {
      console.error("Reminder job reconciliation failed", error instanceof Error ? error.message : "UNKNOWN");
    }
    await sleep(30_000);
  }
}

export function startSchedulerMaintenance() {
  if (state.started) return;
  state.started = true;
  void maintenanceLoop();
  console.log("Reminder job reconciliation is running");
}
