import { NextResponse } from "next/server";
import { and, asc, count, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { requireAdmin } from "@/server/auth";
import { db } from "@/server/db";
import { adminAuditLogs, aiIntentUsages, deliveryAttempts, reminders, serviceHeartbeats, users, wechatBindings } from "@/server/db/schema";
import { apiError } from "@/server/http";
import { deliveryLatencyMs, ON_TIME_THRESHOLD_MS } from "@/lib/delivery-timing";
import { effectiveReminderLimit } from "@/lib/membership";
import { getSystemSettings } from "@/server/system-settings";

const valueOf = (rows: { value: number }[]) => Number(rows[0]?.value || 0);
export async function GET() {
  try {
    await requireAdmin();

    const [
      userCount,
      vipUserCount,
      activeBindingCount,
      upcomingCount,
      deliveryCount,
      sentCount,
      failedCount,
      blockedCount,
      recentUsers,
      recentDeliveries,
      workerHeartbeat,
      todayAiCalls,
      recentAiUsages,
      allBindings,
      recentAudits,
      settings,
    ] = await Promise.all([
      db.select({ value: count() }).from(users),
      db.select({ value: count() }).from(users).where(or(eq(users.vipType, "permanent"), and(eq(users.vipType, "monthly"), gt(users.vipExpiresAt, new Date())))),
      db.select({ value: count() }).from(wechatBindings).where(eq(wechatBindings.status, "active")),
      db.select({ value: count() }).from(reminders).where(eq(reminders.status, "upcoming")),
      db.select({ value: count() }).from(deliveryAttempts),
      db.select({ value: count() }).from(deliveryAttempts).where(eq(deliveryAttempts.status, "sent")),
      db.select({ value: count() }).from(deliveryAttempts).where(and(eq(deliveryAttempts.status, "failed"), isNull(deliveryAttempts.handledAt))),
      db.select({ value: count() }).from(deliveryAttempts).where(and(eq(deliveryAttempts.status, "blocked"), isNull(deliveryAttempts.handledAt))),
      db.select({ id: users.id, username: users.username, displayName: users.displayName, adminNote: users.adminNote, role: users.role, timezone: users.timezone, accountStatus: users.accountStatus, vipType: users.vipType, vipExpiresAt: users.vipExpiresAt, reminderLimitOverride: users.reminderLimitOverride, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt)).limit(100),
      db.select({
        id: deliveryAttempts.id,
        title: reminders.title,
        status: deliveryAttempts.status,
        attempt: deliveryAttempts.attempt,
        scheduledAt: deliveryAttempts.scheduledAt,
        sentAt: deliveryAttempts.sentAt,
        createdAt: deliveryAttempts.createdAt,
        errorCode: deliveryAttempts.errorCode,
        handledAt: deliveryAttempts.handledAt,
        handlingNote: deliveryAttempts.handlingNote,
        displayName: users.displayName,
        username: users.username,
      }).from(deliveryAttempts)
        .innerJoin(reminders, eq(reminders.id, deliveryAttempts.reminderId))
        .innerJoin(users, eq(users.id, reminders.userId))
        .orderBy(desc(deliveryAttempts.createdAt))
        .limit(100),
      db.select({ lastSeenAt: serviceHeartbeats.lastSeenAt }).from(serviceHeartbeats).where(eq(serviceHeartbeats.service, "worker")).limit(1),
      db.select({ value: count() }).from(aiIntentUsages).where(gt(aiIntentUsages.createdAt, new Date(Date.now() - 24 * 60 * 60_000))),
      db.select({ status: aiIntentUsages.status, inputTokens: aiIntentUsages.inputTokens, outputTokens: aiIntentUsages.outputTokens, latencyMs: aiIntentUsages.latencyMs }).from(aiIntentUsages).where(gt(aiIntentUsages.createdAt, new Date(Date.now() - 24 * 60 * 60_000))).limit(1000),
      db.select({ id: wechatBindings.id, userId: users.id, displayName: users.displayName, username: users.username, accountId: wechatBindings.accountId, weixinUserId: wechatBindings.weixinUserId, status: wechatBindings.status, boundAt: wechatBindings.boundAt, lastInboundAt: wechatBindings.lastInboundAt, lastSuccessfulSendAt: wechatBindings.lastSuccessfulSendAt, updatedAt: wechatBindings.updatedAt }).from(wechatBindings).innerJoin(users, eq(users.id, wechatBindings.userId)).orderBy(desc(wechatBindings.updatedAt)).limit(100),
      db.select({ id: adminAuditLogs.id, action: adminAuditLogs.action, targetType: adminAuditLogs.targetType, targetId: adminAuditLogs.targetId, summary: adminAuditLogs.summary, createdAt: adminAuditLogs.createdAt, actorDisplayName: users.displayName, actorUsername: users.username }).from(adminAuditLogs).leftJoin(users, eq(users.id, adminAuditLogs.actorUserId)).orderBy(desc(adminAuditLogs.createdAt)).limit(100),
      getSystemSettings(),
    ]);

    const userIds = recentUsers.map((user) => user.id);
    const [bindings, userReminders] = userIds.length ? await Promise.all([
      db.select({ userId: wechatBindings.userId, status: wechatBindings.status, lastInboundAt: wechatBindings.lastInboundAt, lastSuccessfulSendAt: wechatBindings.lastSuccessfulSendAt }).from(wechatBindings).where(inArray(wechatBindings.userId, userIds)),
      db.select({ id: reminders.id, userId: reminders.userId, title: reminders.title, originalInput: reminders.originalInput, scheduledAt: reminders.scheduledAt, timezone: reminders.timezone, repeatRule: reminders.repeatRule, status: reminders.status, createdAt: reminders.createdAt }).from(reminders).where(and(
        inArray(reminders.userId, userIds),
        inArray(reminders.status, ["upcoming", "paused"]),
      )).orderBy(asc(reminders.scheduledAt)),
    ]) : [[], []];

    const bindingByUser = new Map(bindings.map((binding) => [binding.userId, binding]));
    const remindersByUser = new Map<string, typeof userReminders>();
    for (const reminder of userReminders) remindersByUser.set(reminder.userId, [...(remindersByUser.get(reminder.userId) || []), reminder]);
    const totalDeliveries = valueOf(deliveryCount);
    const sentDeliveries = valueOf(sentCount);
    const deliveryLatencies = recentDeliveries
      .map((attempt) => deliveryLatencyMs(attempt.scheduledAt, attempt.sentAt))
      .filter((latency): latency is number => latency != null);
    const onTimeDeliveries = deliveryLatencies.filter((latency) => latency <= ON_TIME_THRESHOLD_MS).length;
    const aiCompleted = recentAiUsages.filter((item) => item.status === "success");
    const aiTokenTotal = recentAiUsages.reduce((sum, item) => sum + (item.inputTokens || 0) + (item.outputTokens || 0), 0);
    const aiLatencies = recentAiUsages.map((item) => item.latencyMs).filter((value): value is number => value != null);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      service: {
        workerLastSeenAt: workerHeartbeat[0]?.lastSeenAt ?? null,
        workerHealthy: Boolean(workerHeartbeat[0]?.lastSeenAt && Date.now() - workerHeartbeat[0].lastSeenAt.getTime() < 90_000),
        aiCallsLast24Hours: valueOf(todayAiCalls),
        aiSuccessRate: recentAiUsages.length ? Math.round((aiCompleted.length / recentAiUsages.length) * 1000) / 10 : null,
        aiAverageLatencyMs: aiLatencies.length ? Math.round(aiLatencies.reduce((sum, value) => sum + value, 0) / aiLatencies.length) : null,
        aiTokensLast24Hours: aiTokenTotal,
      },
      stats: {
        users: valueOf(userCount),
        vipUsers: valueOf(vipUserCount),
        activeBindings: valueOf(activeBindingCount),
        upcomingReminders: valueOf(upcomingCount),
        totalDeliveries,
        sentDeliveries,
        problemDeliveries: valueOf(failedCount) + valueOf(blockedCount),
        deliveryRate: totalDeliveries ? Math.round((sentDeliveries / totalDeliveries) * 1000) / 10 : null,
        recentOnTimeRate: deliveryLatencies.length ? Math.round((onTimeDeliveries / deliveryLatencies.length) * 1000) / 10 : null,
        recentAverageLatencyMs: deliveryLatencies.length ? Math.round(deliveryLatencies.reduce((sum, latency) => sum + latency, 0) / deliveryLatencies.length) : null,
      },
      users: recentUsers.map((user) => {
        const binding = bindingByUser.get(user.id);
        return {
          id: user.id,
          username: user.username || "legacy-user",
          displayName: user.displayName,
          adminNote: user.adminNote,
          role: user.role,
          timezone: user.timezone,
          accountStatus: user.accountStatus,
          vipType: user.vipType,
          vipExpiresAt: user.vipExpiresAt,
          reminderLimitOverride: user.reminderLimitOverride,
          reminderLimit: effectiveReminderLimit(user),
          createdAt: user.createdAt,
          reminderCount: remindersByUser.get(user.id)?.length || 0,
          reminders: remindersByUser.get(user.id) || [],
          bindingStatus: binding?.status || null,
          lastInboundAt: binding?.lastInboundAt || null,
          lastSuccessfulSendAt: binding?.lastSuccessfulSendAt || null,
        };
      }),
      deliveries: recentDeliveries.map((attempt) => ({
        ...attempt,
        latencyMs: deliveryLatencyMs(attempt.scheduledAt, attempt.sentAt),
        username: attempt.username || "legacy-user",
      })),
      reminders: userReminders.map((reminder) => {
        const owner = recentUsers.find((user) => user.id === reminder.userId);
        return { ...reminder, displayName: owner?.displayName || "未知用户", username: owner?.username || "legacy-user" };
      }),
      bindings: allBindings.map((binding) => ({ ...binding, username: binding.username || "legacy-user" })),
      audits: recentAudits.map((audit) => ({ ...audit, actorDisplayName: audit.actorDisplayName || "系统", actorUsername: audit.actorUsername || "system" })),
      settings,
      errorGroups: Object.entries(recentDeliveries.filter((item) => !item.handledAt && (item.status === "failed" || item.status === "blocked")).reduce<Record<string, number>>((groups, item) => { const code = item.errorCode || "UNKNOWN"; groups[code] = (groups[code] || 0) + 1; return groups; }, {})).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    });
  } catch (error) {
    return apiError(error);
  }
}
