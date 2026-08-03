import { fromPglite, PgBoss } from "pg-boss";
import { pgliteClient } from "./db";

export const REMINDER_QUEUE = "send-reminder";
export type ReminderJobData = { reminderId: string; occurrenceAt?: string; manualRetry?: boolean };
export const REMINDER_WORK_OPTIONS = {
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
  localConcurrency: 4,
  batchSize: 1,
} as const;
const PGLITE_REMINDER_WORK_OPTIONS = {
  pollingIntervalSeconds: 0.5,
  localConcurrency: 1,
  batchSize: 1,
} as const;
const globalForQueue = globalThis as unknown as { bossPromise?: Promise<PgBoss> };

export function getBoss() {
  if (!globalForQueue.bossPromise) {
    globalForQueue.bossPromise = (async () => {
      const boss = pgliteClient
        ? new PgBoss({ db: fromPglite(pgliteClient), backend: "pglite" })
        : new PgBoss({ connectionString: process.env.DATABASE_URL!, useListenNotify: true });
      boss.on("error", (error) => console.error("pg-boss", error));
      await boss.start();
      const queueOptions = { retryLimit: 2, retryDelay: 1, retryBackoff: false, notify: !pgliteClient };
      await boss.createQueue(REMINDER_QUEUE, queueOptions);
      await boss.updateQueue(REMINDER_QUEUE, queueOptions);
      if (pgliteClient) {
        const { deliverReminder } = await import("./delivery");
        await boss.work<ReminderJobData>(REMINDER_QUEUE, PGLITE_REMINDER_WORK_OPTIONS, async (jobs) => {
          for (const job of jobs) await deliverReminder(job.data.reminderId, job.data.occurrenceAt, job.data.manualRetry === true);
        });
      }
      return boss;
    })();
  }
  return globalForQueue.bossPromise;
}

export async function scheduleReminder(reminderId: string, scheduledAt: Date, occurrenceAt = scheduledAt) {
  const boss = await getBoss();
  const occurrenceKey = `${reminderId}:${occurrenceAt.toISOString()}`;
  return boss.send(REMINDER_QUEUE, { reminderId, occurrenceAt: occurrenceAt.toISOString(), manualRetry: false }, { startAfter: scheduledAt, singletonKey: occurrenceKey });
}

export async function scheduleReminderRetry(reminderId: string, scheduledAt: Date, occurrenceAt: Date, retryKey: string) {
  const boss = await getBoss();
  const occurrenceKey = `${reminderId}:${occurrenceAt.toISOString()}:manual:${retryKey}`;
  return boss.send(REMINDER_QUEUE, { reminderId, occurrenceAt: occurrenceAt.toISOString(), manualRetry: true }, { startAfter: scheduledAt, singletonKey: occurrenceKey });
}

export async function cancelScheduledReminder(jobId: string | null) {
  if (!jobId) return;
  const boss = await getBoss();
  await boss.cancel(REMINDER_QUEUE, jobId);
}
