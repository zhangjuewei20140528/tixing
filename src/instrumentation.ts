export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DATABASE_MODE === "pglite") {
    const [{ startInboundPolling }, { startSchedulerMaintenance }] = await Promise.all([
      import("./server/inbound"),
      import("./server/scheduler"),
    ]);
    startInboundPolling();
    startSchedulerMaintenance();
  }
}
