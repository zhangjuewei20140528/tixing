import type { ReminderJobData } from "./server/queue";

async function main() {
  if (process.env.DATABASE_MODE === "pglite") {
    console.log("PGlite runs its reminder worker inside the Next.js process; no separate worker is needed.");
    return;
  }
  const [{ deliverReminder }, { getBoss, REMINDER_QUEUE, REMINDER_WORK_OPTIONS }, { startInboundPolling }, { startSchedulerMaintenance }] = await Promise.all([
    import("./server/delivery"),
    import("./server/queue"),
    import("./server/inbound"),
    import("./server/scheduler"),
  ]);
  const boss = await getBoss();
  await boss.work<ReminderJobData>(REMINDER_QUEUE, REMINDER_WORK_OPTIONS, async (jobs) => {
    for (const job of jobs) await deliverReminder(job.data.reminderId, job.data.occurrenceAt, job.data.manualRetry === true);
  });
  startInboundPolling();
  startSchedulerMaintenance();
  console.log("Reminder and Weixin inbound workers are running");
}

main().catch((error) => { console.error(error); process.exit(1); });
