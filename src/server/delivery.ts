import { and, eq, inArray, isNull } from "drizzle-orm";
import { resolveDeliveryFinalization } from "@/lib/reminder-delivery";
import { decideExistingDeliveryAttempt } from "@/lib/delivery-retry";
import { clawBotConnector } from "./clawbot";
import { decryptSecret } from "./crypto";
import { db } from "./db";
import { deliveryAttempts, reminders, users, wechatBindings } from "./db/schema";
import { scheduleReminder } from "./queue";

export async function finalizeDeliveredOccurrence(reminderId: string, occurrenceAt: Date) {
  const [reminder] = await db.select().from(reminders).where(eq(reminders.id, reminderId)).limit(1);
  if (!reminder) return { finalized: false };
  const action = resolveDeliveryFinalization({
    status: reminder.status,
    repeatRule: reminder.repeatRule,
    scheduledAt: reminder.scheduledAt,
    occurrenceAt,
    repeatUntil: reminder.repeatUntil,
  });
  if (action.kind === "noop") return { finalized: false };

  if (action.kind === "complete") {
    const [completed] = await db.update(reminders).set({
      status: "completed",
      queueJobId: null,
      version: reminder.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(reminders.id, reminder.id),
      eq(reminders.status, "upcoming"),
      eq(reminders.version, reminder.version),
      eq(reminders.scheduledAt, occurrenceAt),
    )).returning({ id: reminders.id });
    return { finalized: Boolean(completed), completed: Boolean(completed) };
  }

  const jobId = await scheduleReminder(reminder.id, action.scheduledAt);
  const [advanced] = await db.update(reminders).set({
    scheduledAt: action.scheduledAt,
    queueJobId: jobId,
    version: reminder.version + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(reminders.id, reminder.id),
    eq(reminders.status, "upcoming"),
    eq(reminders.version, reminder.version),
    eq(reminders.scheduledAt, occurrenceAt),
  )).returning({ id: reminders.id });
  return { finalized: Boolean(advanced), advanced: Boolean(advanced) };
}

export async function deliverReminder(reminderId: string, expectedOccurrenceAt?: string, manualRetry = false) {
  const [reminder] = await db.select().from(reminders).where(and(eq(reminders.id, reminderId), eq(reminders.status, "upcoming"))).limit(1);
  if (!reminder) return { skipped: true };
  if (expectedOccurrenceAt && reminder.scheduledAt.toISOString() !== expectedOccurrenceAt) return { skipped: true, stale: true };
  const idempotencyKey = `${reminder.id}:${reminder.scheduledAt.toISOString()}`;
  const [[user], [binding]] = await Promise.all([
    db.select({ accountStatus: users.accountStatus }).from(users).where(eq(users.id, reminder.userId)).limit(1),
    db.select().from(wechatBindings).where(and(eq(wechatBindings.userId, reminder.userId), eq(wechatBindings.status, "active"))).limit(1),
  ]);
  const bindingError = !user || user.accountStatus === "disabled"
    ? { code: "ACCOUNT_DISABLED", message: "用户账号已停用，提醒暂不投递" }
    : !binding
    ? { code: "WECHAT_NOT_BOUND", message: "用户尚未绑定微信" }
    : null;
  const [inserted] = await db.insert(deliveryAttempts).values({ reminderId: reminder.id, idempotencyKey, accountId: binding?.accountId, recipientId: binding?.weixinUserId, scheduledAt: reminder.scheduledAt, status: bindingError ? "blocked" : "pending", errorCode: bindingError?.code ?? null, errorMessage: bindingError?.message ?? null }).onConflictDoNothing().returning();
  let attempt = inserted;
  if (!attempt) {
    const [existing] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.idempotencyKey, idempotencyKey)).limit(1);
    if (!existing) return { duplicate: true };
    if (existing.status === "sent") {
      await finalizeDeliveredOccurrence(reminder.id, reminder.scheduledAt);
      return { duplicate: true, finalized: true };
    }
    if (existing.status === "pending") return { duplicate: true, pending: true };
    if (existing.handledAt) return { skipped: true, handled: true };
    if (bindingError) {
      await db.update(deliveryAttempts).set({ status: "blocked", errorCode: bindingError.code, errorMessage: bindingError.message }).where(eq(deliveryAttempts.id, existing.id));
      return { blocked: true };
    }
    const decision = decideExistingDeliveryAttempt({
      status: existing.status,
      attempt: existing.attempt,
      handled: Boolean(existing.handledAt),
      manualRetry,
    });
    if (decision === "handled") return { skipped: true, handled: true };
    if (decision === "duplicate") return { duplicate: true };
    if (decision === "exhausted") {
      console.warn("Automatic reminder delivery retry limit reached", { reminderId, attempt: existing.attempt });
      return { skipped: true, exhausted: true };
    }
    // Claim the failed delivery atomically. A duplicate queue job will lose this update and stop.
    [attempt] = await db.update(deliveryAttempts).set({ status: "pending", attempt: existing.attempt + 1, accountId: binding.accountId, recipientId: binding.weixinUserId, errorCode: null, errorMessage: null }).where(and(
      eq(deliveryAttempts.id, existing.id),
      inArray(deliveryAttempts.status, ["failed", "blocked"]),
      isNull(deliveryAttempts.handledAt),
    )).returning();
    if (!attempt) return { duplicate: true };
  }
  if (!binding || bindingError) return { blocked: true };
  try {
    const result = await clawBotConnector.send({ accountId: binding.accountId, to: binding.weixinUserId, botToken: decryptSecret(binding.encryptedBotToken), baseUrl: binding.baseUrl, content: `提醒：${reminder.title}`, idempotencyKey });
    await db.transaction(async (tx) => {
      await tx.update(deliveryAttempts).set({ status: "sent", sentAt: new Date(), providerMessageId: result.messageId, providerResponse: result.raw ?? null }).where(eq(deliveryAttempts.id, attempt.id));
      await tx.update(wechatBindings).set({ lastSuccessfulSendAt: new Date(), updatedAt: new Date() }).where(eq(wechatBindings.id, binding.id));
    });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : "UNKNOWN";
    const errorMessage = errorCode.startsWith("CLAWBOT_SEND_-2")
      ? "微信会话准备失败，系统自动重试后仍未成功，请稍后重试"
      : "微信 iLink 投递失败";
    await db.update(deliveryAttempts).set({ status: "failed", errorCode, errorMessage }).where(eq(deliveryAttempts.id, attempt.id));
    console.warn("Reminder delivery failed", { reminderId, attempt: attempt.attempt, accountId: binding.accountId, errorCode });
    throw error;
  }
  await finalizeDeliveredOccurrence(reminder.id, reminder.scheduledAt);
  return { sent: true };
}
