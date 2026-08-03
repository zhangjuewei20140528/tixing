export const ON_TIME_THRESHOLD_MS = 5_000;

export function deliveryLatencyMs(scheduledAt: Date | string, sentAt: Date | string | null) {
  if (!sentAt) return null;
  const latency = new Date(sentAt).getTime() - new Date(scheduledAt).getTime();
  return Number.isFinite(latency) ? Math.max(0, latency) : null;
}

export function formatDeliveryTiming(latencyMs: number | null) {
  if (latencyMs == null) return null;
  if (latencyMs <= ON_TIME_THRESHOLD_MS) return "准时";
  if (latencyMs < 60_000) return `延迟 ${Math.ceil(latencyMs / 1_000)} 秒`;
  return `延迟 ${Math.ceil(latencyMs / 60_000)} 分钟`;
}
