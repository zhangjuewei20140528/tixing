import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { mergeReminderEditTimeClarification, parseNumberedMenuChoice, parseReminderCandidateChoice, parseReminderCancelCommand, parseReminderEditCommand, parseReminderSnoozeCommand, parseReminderStateCommand, reminderEditTimeNeedsClarification, reminderTargetMatches, resolveReminderEditTime, type ReminderEditCommand } from "@/lib/reminder-command";
import { isSpecificReminderTitle, parseChineseReminder, parseChineseReminders, resolveReminderClarificationStep, type ParsedReminder, type ReminderClarification } from "@/lib/reminder-parser";
import { nextFutureOccurrence } from "@/lib/reminder-schedule";
import { membershipStatusText } from "@/lib/membership";
import { shouldUseAiForConversationalReminder } from "@/lib/reminder-intent-guard";
import { cleanAiReminderTitle } from "@/lib/reminder-title";
import { clawBotConnector, type ILinkInboundMessage } from "./clawbot";
import { decryptSecret } from "./crypto";
import { db } from "./db";
import { deliveryAttempts, inboundCommandReceipts, pendingInboundClarifications, reminders, users, wechatBindings } from "./db/schema";
import { cancelScheduledReminder, scheduleReminder } from "./queue";
import { assertReminderCapacity, ReminderLimitError } from "./reminder-quota";
import { analyzeReminderIntent, isReminderDomainMessage } from "./reminder-intent-provider";

const HELP_TEXT = "您好，我是准点提醒助手。\n\n1. 新建提醒\n2. 查看提醒\n3. 修改提醒\n4. 取消提醒\n5. 暂停/恢复\n6. 取消全部\n\n回复数字，或直接说“明早8点提醒我喝水”。";
const LIST_CLARIFICATION_PREFIX = "__list_context__:";
const CREATE_CLARIFICATION_PREFIX = "__create_clarification__:";
const CANCEL_ALL_CONFIRMATION_VALUE = "__cancel_all_confirmation__";

type PendingListContext = {
  ids: string[];
  page: number;
  action: "view" | "edit" | "cancel";
  stage?: "select" | "edit_value";
  reminderId?: string;
};

const LIST_PAGE_SIZE = 8;

type PendingCreateClarification = Pick<ReminderClarification, "originalInput" | "reason" | "prompt"> & {
  scheduledAt?: string;
  parsed?: ParsedReminder;
};

type Binding = typeof wechatBindings.$inferSelect;

type InboundState = {
  started: boolean;
  loops: Map<string, Promise<void>>;
  handleMessage?: (binding: Binding, message: ILinkInboundMessage) => Promise<void>;
};

const globalForInbound = globalThis as unknown as { inboundState?: InboundState };
const state = globalForInbound.inboundState ?? { started: false, loops: new Map<string, Promise<void>>() };
if (process.env.NODE_ENV !== "production") globalForInbound.inboundState = state;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message: ILinkInboundMessage) {
  return (message.item_list ?? [])
    .filter((item) => item.type === 1 && item.text_item?.text)
    .map((item) => item.text_item!.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sourceMessageId(binding: Binding, message: ILinkInboundMessage) {
  const providerId = message.client_id || String(message.message_id ?? `${message.create_time_ms ?? Date.now()}:${messageText(message)}`);
  return `weixin:${binding.accountId}:${providerId}`;
}

function formatReminderTime(value: Date, timezone: string, now = new Date()) {
  const dateText = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
  const todayText = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);
  const tomorrowText = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrow);
  const timeText = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
  const dayLabel = dateText === todayText ? "今天" : dateText === tomorrowText ? "明天" : new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric", weekday: "short" }).format(value);
  return `${dayLabel}${timeText}`;
}

function repeatRuleLabel(repeatRule: string) {
  return repeatRule === "daily" ? "每天" : repeatRule === "weekdays" ? "工作日" : repeatRule === "weekly" ? "每周" : repeatRule === "monthly:last" ? "每月最后一天" : repeatRule.startsWith("monthly:") ? `每月${repeatRule.slice(8)}号` : "";
}

async function reply(binding: Binding, message: ILinkInboundMessage, content: string, options: { showMembership?: boolean; idempotencySuffix?: string } = {}) {
  if (!message.from_user_id) return;
  const startedAt = Date.now();
  let identifiedContent = content;
  if (options.showMembership) {
    const [user] = await db.select({ vipType: users.vipType, vipExpiresAt: users.vipExpiresAt, timezone: users.timezone })
      .from(users).where(eq(users.id, binding.userId)).limit(1);
    if (user) identifiedContent = `【${membershipStatusText(user.vipType, user.vipExpiresAt, new Date(), user.timezone)}】\n${content}`;
  }
  await clawBotConnector.send({
    accountId: binding.accountId,
    to: message.from_user_id,
    botToken: decryptSecret(binding.encryptedBotToken),
    baseUrl: binding.baseUrl,
    content: identifiedContent,
    contextToken: message.context_token,
    idempotencyKey: `${sourceMessageId(binding, message)}:${options.idempotencySuffix || "reply"}`,
  });
  const providerCreatedAt = Number(message.create_time_ms);
  console.info("Inbound reply timing", {
    userId: binding.userId,
    sendMs: Date.now() - startedAt,
    totalMs: Number.isFinite(providerCreatedAt) && providerCreatedAt > 0 ? Math.max(0, Date.now() - providerCreatedAt) : null,
    contentLength: identifiedContent.length,
  });
}

async function previousCommandResponse(userId: string, messageId: string) {
  const [receipt] = await db.select({ responseText: inboundCommandReceipts.responseText }).from(inboundCommandReceipts)
    .where(and(eq(inboundCommandReceipts.userId, userId), eq(inboundCommandReceipts.sourceMessageId, messageId))).limit(1);
  return receipt?.responseText;
}

async function saveCommandReceipt(userId: string, reminderId: string | null, messageId: string, commandType: string, responseText: string) {
  await db.insert(inboundCommandReceipts).values({ userId, reminderId, sourceMessageId: messageId, commandType, responseText })
    .onConflictDoNothing({ target: inboundCommandReceipts.sourceMessageId });
}

async function quotaUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user;
}

function reminderLimitFailureMessage(error: unknown) {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: string }).code;
  return error instanceof ReminderLimitError || code === "REMINDER_LIMIT_REACHED" || /只能设置\s*\d+\s*条有效提醒|提醒数量已达上限/.test(error.message) ? error.message : null;
}

async function listReminders(binding: Binding, message: ILinkInboundMessage, action: PendingListContext["action"] = "view", page = 0, snapshotIds?: string[]) {
  const queried = await db.select({ id: reminders.id, title: reminders.title, scheduledAt: reminders.scheduledAt, queueJobId: reminders.queueJobId, repeatRule: reminders.repeatRule }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming")))
    .orderBy(asc(reminders.scheduledAt)).limit(20);
  const rows = snapshotIds?.length
    ? snapshotIds.map((id) => queried.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : queried;
  if (rows.length === 0) return reply(binding, message, "你目前没有待提醒事项。\n发送“明天下午3点提醒我开会”即可创建。");
  const pageSize = LIST_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const visible = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const lines = visible.map((item, index) => `${safePage * pageSize + index + 1}. ${formatReminderTime(item.scheduledAt, "Asia/Shanghai")} ${item.title}${item.repeatRule === "once" ? "" : `（${repeatRuleLabel(item.repeatRule)}）`}`);
  const actionPrompt = action === "edit" ? "\n回复序号选择要修改的提醒。"
    : action === "cancel" ? "\n回复序号选择要取消的提醒。"
      : "\n可以说“取消提醒2”或“把提醒2改到晚上8点”。";
  const pagePrompt = totalPages > 1 ? `\n第 ${safePage + 1}/${totalPages} 页，回复“下一页”或“上一页”。` : "";
  await rememberClarification(binding, `${LIST_CLARIFICATION_PREFIX}${JSON.stringify({ ids: rows.map((item) => item.id), page: safePage, action, stage: "select" } satisfies PendingListContext)}`, sourceMessageId(binding, message));
  return reply(binding, message, `你的待提醒事项（共 ${rows.length} 条）：\n${lines.join("\n")}${pagePrompt}${actionPrompt}`);
}

async function listPausedReminders(binding: Binding, message: ILinkInboundMessage) {
  const rows = await db.select({ title: reminders.title, scheduledAt: reminders.scheduledAt, repeatRule: reminders.repeatRule }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.status, "paused")))
    .orderBy(asc(reminders.scheduledAt)).limit(11);
  if (rows.length === 0) return reply(binding, message, "你目前没有已暂停的提醒。");
  const visible = rows.slice(0, 10);
  const lines = visible.map((item, index) => `${index + 1}. ${item.title}（${repeatRuleLabel(item.repeatRule)}）`);
  const overflow = rows.length > 10 ? "\n仅显示前 10 条" : "";
  return reply(binding, message, `已暂停的重复提醒：\n${lines.join("\n")}${overflow}\n恢复请发送“恢复提醒1”`);
}

function isListCommand(text: string) {
  const normalized = text.replace(/[\s，,。!！?？]/g, "");
  return /^(?:查看|查询|看看)?(?:我的)?提醒(?:列表)?$/.test(normalized)
    || /^(?:我)?有(?:哪些|什么)提醒$/.test(normalized)
    || /^(?:帮我)?看看(?:我的)?提醒$/.test(normalized)
    || /^(?:我)?(?:接下来|之后)有(?:哪些|什么)(?:安排|提醒)$/.test(normalized)
    || /^(?:还有|剩下)(?:哪些|什么)?提醒$/.test(normalized)
    || /^(?:看看|查看)(?:我的)?日程$/.test(normalized);
}

function isPausedListCommand(text: string) {
  const normalized = text.replace(/[\s，,。!！?？]/g, "");
  return /^(?:查看|查询|看看)?(?:我的)?(?:已)?暂停提醒(?:列表)?$/.test(normalized);
}

async function changeRecurringReminderState(binding: Binding, message: ILinkInboundMessage, action: "pause" | "resume", target: string, forcedReminderId?: string) {
  const desiredStatus = action === "pause" ? "paused" : "upcoming";
  const currentStatus = action === "pause" ? "upcoming" : "paused";
  const messageId = sourceMessageId(binding, message);
  const previousResponse = await previousCommandResponse(binding.userId, messageId);
  if (previousResponse) return reply(binding, message, previousResponse);

  const rows = await db.select({
    id: reminders.id,
    title: reminders.title,
    scheduledAt: reminders.scheduledAt,
    timezone: reminders.timezone,
    repeatRule: reminders.repeatRule,
    queueJobId: reminders.queueJobId,
    version: reminders.version,
  }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.status, currentStatus)))
    .orderBy(asc(reminders.scheduledAt)).limit(20);
  if (rows.length === 0) return reply(binding, message, action === "pause" ? "你目前没有可以暂停的重复提醒。" : "你目前没有可以恢复的提醒。");

  const matches = forcedReminderId ? rows.filter((item) => item.id === forcedReminderId) : reminderTargetMatches(rows, target);
  if (matches.length > 1) return reply(binding, message, `找到多条符合“${target}”的提醒。请加上时间，例如“暂停明天早上8点的喝水”。`);
  const selected = matches[0];
  if (!selected) return reply(binding, message, `没有找到该提醒。\n发送“${action === "pause" ? "查看提醒" : "查看暂停提醒"}”获取最新编号。`);
  if (selected.repeatRule === "once") return reply(binding, message, "只有每天、工作日、每周或每月重复的提醒可以暂停。");

  if (action === "pause") {
    const responseText = `已暂停重复提醒：\n${selected.title}`;
    const [paused] = await db.update(reminders).set({
      status: desiredStatus,
      version: selected.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(reminders.id, selected.id),
      eq(reminders.userId, binding.userId),
      eq(reminders.status, currentStatus),
      eq(reminders.version, selected.version),
    )).returning({ id: reminders.id });
    if (!paused) return reply(binding, message, "该提醒刚刚发生了变化，请重新查看后再试。");
    await saveCommandReceipt(binding.userId, selected.id, messageId, "pause", responseText);
    await cancelScheduledReminder(selected.queueJobId).catch((error) => {
      console.error("Failed to cancel paused reminder job", { reminderId: selected.id, error: error instanceof Error ? error.message : "UNKNOWN" });
    });
    return reply(binding, message, responseText);
  }

  const scheduledAt = nextFutureOccurrence(selected.scheduledAt, selected.repeatRule);
  if (!scheduledAt) return reply(binding, message, "无法计算下一次提醒时间。");
  const responseText = `已恢复重复提醒：\n${formatReminderTime(scheduledAt, selected.timezone)} ${selected.title}`;
  const newJobId = await scheduleReminder(selected.id, scheduledAt);
  let resumed: { id: string } | undefined;
  try {
    [resumed] = await db.update(reminders).set({
      status: desiredStatus,
      scheduledAt,
      queueJobId: newJobId,
      version: selected.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(reminders.id, selected.id),
      eq(reminders.userId, binding.userId),
      eq(reminders.status, currentStatus),
      eq(reminders.version, selected.version),
    )).returning({ id: reminders.id });
  } catch (error) {
    await cancelScheduledReminder(newJobId).catch(() => undefined);
    throw error;
  }
  if (!resumed) {
    await cancelScheduledReminder(newJobId).catch(() => undefined);
    return reply(binding, message, "该提醒刚刚发生了变化，请重新查看后再试。");
  }
  await saveCommandReceipt(binding.userId, selected.id, messageId, "resume", responseText);
  return reply(binding, message, responseText);
}

async function snoozeLatestReminder(binding: Binding, message: ILinkInboundMessage, text: string, scheduledAt: Date) {
  const messageId = sourceMessageId(binding, message);
  const [handled] = await db.select().from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.sourceMessageId, messageId))).limit(1);
  if (handled) return reply(binding, message, `该延后请求已处理：\n${formatReminderTime(handled.scheduledAt, handled.timezone)} ${handled.title}`);

  const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
  const [latest] = await db.select({ title: reminders.title }).from(deliveryAttempts)
    .innerJoin(reminders, eq(reminders.id, deliveryAttempts.reminderId))
    .where(and(
      eq(reminders.userId, binding.userId),
      eq(deliveryAttempts.status, "sent"),
      gte(deliveryAttempts.sentAt, cutoff),
    ))
    .orderBy(desc(deliveryAttempts.sentAt)).limit(1);
  if (!latest) return reply(binding, message, "没有找到最近 24 小时内已发送的提醒。\n请说具体事项，例如“10分钟后提醒我喝水”。");
  const user = await quotaUser(binding.userId);
  if (!user || user.accountStatus === "disabled") throw new Error("ACCOUNT_DISABLED");
  await assertReminderCapacity(user, 1);

  const [created] = await db.insert(reminders).values({
    userId: binding.userId,
    title: latest.title,
    originalInput: text,
    scheduledAt,
    repeatRule: "once",
    sourceChannel: "weixin-snooze",
    sourceMessageId: messageId,
  }).onConflictDoNothing({ target: reminders.sourceMessageId }).returning();

  let reminder = created;
  if (created) {
    try {
      const jobId = await scheduleReminder(created.id, created.scheduledAt);
      [reminder] = await db.update(reminders).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(reminders.id, created.id)).returning();
    } catch (error) {
      await db.delete(reminders).where(eq(reminders.id, created.id));
      throw error;
    }
  } else {
    [reminder] = await db.select().from(reminders).where(eq(reminders.sourceMessageId, messageId)).limit(1);
  }
  if (!reminder) return;
  return reply(binding, message, `已延后提醒：\n${formatReminderTime(reminder.scheduledAt, reminder.timezone)} ${reminder.title}`);
}

async function cancelReminder(binding: Binding, message: ILinkInboundMessage, target: string, forcedReminderId?: string) {
  const messageId = sourceMessageId(binding, message);
  const previousResponse = await previousCommandResponse(binding.userId, messageId);
  if (previousResponse) return reply(binding, message, previousResponse);

  const rows = await db.select({ id: reminders.id, title: reminders.title, scheduledAt: reminders.scheduledAt, queueJobId: reminders.queueJobId, version: reminders.version }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming")))
    .orderBy(asc(reminders.scheduledAt)).limit(20);
  if (rows.length === 0) return reply(binding, message, "你目前没有可以取消的提醒。");
  if (!target) return listReminders(binding, message);

  const matches = forcedReminderId ? rows.filter((item) => item.id === forcedReminderId) : reminderTargetMatches(rows, target);
  if (matches.length > 1) {
    const candidates = matches.slice(0, 5);
    const lines = candidates.map((item, index) => `${index + 1}. ${formatReminderTime(item.scheduledAt, "Asia/Shanghai")} ${item.title}`);
    const prompt = `找到多个包含“${target}”的提醒：\n${lines.join("\n")}\n你想取消哪一条？请回复序号，例如“第一个”。回复“算了”可以放弃取消。`;
    await rememberCancelClarification(binding, { target, candidateIds: candidates.map((item) => item.id), prompt }, messageId);
    return reply(binding, message, prompt);
  }
  const selected = matches[0];
  if (!selected) return reply(binding, message, "没有找到该提醒。\n发送“查看提醒”获取最新编号。");

  const responseText = `已取消提醒：\n${formatReminderTime(selected.scheduledAt, "Asia/Shanghai")} ${selected.title}`;
  const [cancelled] = await db.update(reminders).set({
    status: "cancelled",
    version: selected.version + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(reminders.id, selected.id),
    eq(reminders.userId, binding.userId),
    eq(reminders.status, "upcoming"),
    eq(reminders.version, selected.version),
  )).returning({ id: reminders.id });
  if (!cancelled) return reply(binding, message, "该提醒刚刚发生了变化，请发送“查看提醒”后重试。");
  await saveCommandReceipt(binding.userId, selected.id, messageId, "cancel", responseText);

  try {
    await cancelScheduledReminder(selected.queueJobId);
  } catch (error) {
    console.error("Failed to cancel superseded reminder job", { reminderId: selected.id, error: error instanceof Error ? error.message : "UNKNOWN" });
  }
  return reply(binding, message, responseText);
}

async function cancelAllReminders(binding: Binding, message: ILinkInboundMessage, confirmed = false) {
  const messageId = sourceMessageId(binding, message);
  const previousResponse = await previousCommandResponse(binding.userId, messageId);
  if (previousResponse) return reply(binding, message, previousResponse);
  const active = await db.select({ id: reminders.id, queueJobId: reminders.queueJobId }).from(reminders).where(and(
    eq(reminders.userId, binding.userId),
    inArray(reminders.status, ["upcoming", "paused"]),
  ));
  if (!active.length) return reply(binding, message, "你目前没有需要取消的提醒。");
  if (!confirmed) {
    await rememberClarification(binding, CANCEL_ALL_CONFIRMATION_VALUE, messageId);
    return reply(binding, message, `你有 ${active.length} 条有效提醒。确定全部取消吗？\n回复“确认取消”才会执行，回复“算了”保留全部提醒。`);
  }
  await db.update(reminders).set({ status: "cancelled", updatedAt: new Date() }).where(and(
    eq(reminders.userId, binding.userId),
    inArray(reminders.status, ["upcoming", "paused"]),
  ));
  await Promise.all(active.map((item) => cancelScheduledReminder(item.queueJobId).catch((error) => {
    console.error("Failed to cancel reminder during inbound cancel-all", { reminderId: item.id, error: error instanceof Error ? error.message : "UNKNOWN" });
  })));
  const responseText = `已取消全部提醒，共 ${active.length} 条。`;
  await saveCommandReceipt(binding.userId, null, messageId, "cancel_all", responseText);
  return reply(binding, message, responseText);
}

async function completeReminder(binding: Binding, message: ILinkInboundMessage, target: string, forcedReminderId?: string) {
  const rows = await db.select({ id: reminders.id, title: reminders.title, scheduledAt: reminders.scheduledAt, repeatRule: reminders.repeatRule, queueJobId: reminders.queueJobId, version: reminders.version })
    .from(reminders).where(and(eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming"))).orderBy(asc(reminders.scheduledAt)).limit(20);
  if (!rows.length) return reply(binding, message, "你目前没有待完成的提醒。");
  const matches = forcedReminderId ? rows.filter((item) => item.id === forcedReminderId) : reminderTargetMatches(rows, target);
  if (matches.length > 1) return reply(binding, message, `找到多条符合“${target}”的提醒，请说序号或补充时间。`);
  const selected = matches[0];
  if (!selected) return reply(binding, message, "没有找到这条提醒。请先发送“查看提醒”获取序号。");
  if (selected.repeatRule !== "once") return reply(binding, message, `已记录“${selected.title}”本次完成，后续${repeatRuleLabel(selected.repeatRule)}提醒仍会继续。`);
  const [completed] = await db.update(reminders).set({ status: "completed", version: selected.version + 1, updatedAt: new Date() })
    .where(and(eq(reminders.id, selected.id), eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming"), eq(reminders.version, selected.version))).returning({ id: reminders.id });
  if (!completed) return reply(binding, message, "这条提醒刚刚发生了变化，请重新查看后再试。");
  await cancelScheduledReminder(selected.queueJobId).catch(() => undefined);
  return reply(binding, message, `已完成提醒：${selected.title}`);
}

async function editReminder(binding: Binding, message: ILinkInboundMessage, edit: ReminderEditCommand, forcedReminderId?: string) {
  const { target, timeText, titleText } = edit;
  const messageId = sourceMessageId(binding, message);
  const previousResponse = await previousCommandResponse(binding.userId, messageId);
  if (previousResponse) return reply(binding, message, previousResponse);

  const rows = await db.select({
    id: reminders.id,
    title: reminders.title,
    scheduledAt: reminders.scheduledAt,
    timezone: reminders.timezone,
    repeatRule: reminders.repeatRule,
    queueJobId: reminders.queueJobId,
    version: reminders.version,
  }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming")))
    .orderBy(asc(reminders.scheduledAt)).limit(20);
  if (rows.length === 0) return reply(binding, message, "你目前没有可以修改的提醒。");

  const matches = forcedReminderId ? rows.filter((item) => item.id === forcedReminderId) : reminderTargetMatches(rows, target);
  if (matches.length > 1) {
    const candidates = matches.slice(0, 5);
    const lines = candidates.map((item, index) => `${index + 1}. ${formatReminderTime(item.scheduledAt, item.timezone)} ${item.title}`);
    const prompt = `找到多个包含“${target}”的提醒：\n${lines.join("\n")}\n请回复序号，例如“第一个”。回复“取消”可以放弃修改。`;
    await rememberEditClarification(binding, { stage: "target", edit, candidateIds: candidates.map((item) => item.id), prompt }, messageId);
    return reply(binding, message, prompt);
  }
  const selected = matches[0];
  if (!selected) return reply(binding, message, "没有找到该提醒。\n发送“查看提醒”获取最新编号。");

  if (titleText) {
    const nextTitle = titleText.slice(0, 100).trim();
    if (!nextTitle) return reply(binding, message, "新的提醒内容不能为空。");
    const responseText = `已修改提醒内容：\n原内容：${selected.title}\n新内容：${nextTitle}\n提醒时间：${formatReminderTime(selected.scheduledAt, selected.timezone)}`;
    const [updated] = await db.update(reminders).set({
      title: nextTitle,
      version: selected.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(reminders.id, selected.id),
      eq(reminders.userId, binding.userId),
      eq(reminders.status, "upcoming"),
      eq(reminders.version, selected.version),
    )).returning({ id: reminders.id });
    if (!updated) return reply(binding, message, "该提醒刚刚发生了变化，请发送“查看提醒”后重试。");
    await saveCommandReceipt(binding.userId, selected.id, messageId, "edit", responseText);
    return reply(binding, message, responseText);
  }

  if (!timeText || reminderEditTimeNeedsClarification(timeText)) {
    const period = timeText?.match(/凌晨|早上|上午|中午|下午|晚上|今晚|明早|明晚/)?.[0];
    const prompt = period
      ? `我已找到“${selected.title}”，还需要准确时间。${period}几点？例如回复“${period}8点”。回复“取消”可以放弃修改。`
      : `我已找到“${selected.title}”，但还没有准确的新时间。请回复例如“明天下午3点”。回复“取消”可以放弃修改。`;
    await rememberEditClarification(binding, { stage: "time", edit, reminderId: selected.id, prompt }, messageId);
    return reply(binding, message, prompt);
  }

  const now = new Date();
  const scheduledAt = resolveReminderEditTime(timeText, selected.scheduledAt, selected.repeatRule, now);
  if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) return reply(binding, message, "没有识别出新的提醒时间。\n例如：把提醒2改到明天下午3点");
  if (scheduledAt <= now) {
    return reply(binding, message, "新的提醒时间必须晚于现在。");
  }

  const responseText = `已修改提醒：\n${selected.title}\n原时间：${formatReminderTime(selected.scheduledAt, selected.timezone)}\n新时间：${formatReminderTime(scheduledAt, selected.timezone)}`;
  const newJobId = await scheduleReminder(selected.id, scheduledAt);
  let updated: { id: string } | undefined;
  try {
    [updated] = await db.update(reminders).set({
      scheduledAt,
      queueJobId: newJobId,
      version: selected.version + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(reminders.id, selected.id),
      eq(reminders.userId, binding.userId),
      eq(reminders.status, "upcoming"),
      eq(reminders.version, selected.version),
    )).returning({ id: reminders.id });
  } catch (error) {
    await cancelScheduledReminder(newJobId).catch(() => undefined);
    const duplicateResponse = await previousCommandResponse(binding.userId, messageId);
    if (duplicateResponse) return reply(binding, message, duplicateResponse);
    throw error;
  }
  if (!updated) {
    await cancelScheduledReminder(newJobId).catch(() => undefined);
    return reply(binding, message, "该提醒刚刚发生了变化，请发送“查看提醒”后重试。");
  }
  await saveCommandReceipt(binding.userId, selected.id, messageId, "edit", responseText);

  try {
    await cancelScheduledReminder(selected.queueJobId);
  } catch (error) {
    console.error("Failed to cancel superseded reminder job", { reminderId: selected.id, error: error instanceof Error ? error.message : "UNKNOWN" });
  }
  return reply(binding, message, responseText);
}

async function createParsedReminders(binding: Binding, message: ILinkInboundMessage, text: string, parsedItems: ParsedReminder[], sourceSuffix = "") {
  if (!parsedItems.length) return [];
  if (parsedItems.some((item) => item.title === "新提醒")) throw new Error("REMINDER_TITLE_REQUIRED");
  const user = await quotaUser(binding.userId);
  if (!user || user.accountStatus === "disabled") throw new Error("ACCOUNT_DISABLED");
  await assertReminderCapacity(user, parsedItems.length);
  const baseMessageId = `${sourceMessageId(binding, message)}${sourceSuffix}`;
  const createdIds: string[] = [];
  const saved: (typeof reminders.$inferSelect)[] = [];
  try {
    for (const [index, parsed] of parsedItems.entries()) {
      const idempotencyKey = `${baseMessageId}:${index + 1}`;
      const [created] = await db.insert(reminders).values({
        userId: binding.userId,
        title: parsed.title,
        originalInput: text,
        scheduledAt: new Date(parsed.scheduledAt),
        repeatRule: parsed.repeatRule,
        repeatUntil: parsed.repeatUntil ? new Date(parsed.repeatUntil) : null,
        sourceChannel: "weixin-ilink",
        sourceMessageId: idempotencyKey,
      }).onConflictDoNothing({ target: reminders.sourceMessageId }).returning();
      if (!created) {
        const [existing] = await db.select().from(reminders).where(eq(reminders.sourceMessageId, idempotencyKey)).limit(1);
        if (existing) saved.push(existing);
        continue;
      }
      createdIds.push(created.id);
      const jobId = await scheduleReminder(created.id, created.scheduledAt);
      const [reminder] = await db.update(reminders).set({ queueJobId: jobId, updatedAt: new Date() }).where(eq(reminders.id, created.id)).returning();
      saved.push(reminder);
    }
    return saved;
  } catch (error) {
    await Promise.all(saved.filter((item) => createdIds.includes(item.id)).map((item) => cancelScheduledReminder(item.queueJobId).catch(() => undefined)));
    if (createdIds.length) await db.delete(reminders).where(inArray(reminders.id, createdIds));
    throw error;
  }
}

function createdReminderResponse(items: (typeof reminders.$inferSelect)[], parsedItems: ParsedReminder[]) {
  if (items.length === 1) {
    const item = items[0];
    const parsed = parsedItems[0];
    const repeat = parsed?.repeatRule === "once" ? "" : `，${parsed?.repeatLabel || repeatRuleLabel(item.repeatRule)}`;
    return `好的，${formatReminderTime(item.scheduledAt, item.timezone)}提醒你“${item.title}”${repeat}。`;
  }
  const lines = items.map((item, index) => {
    const parsed = parsedItems[index];
    const repeat = parsed?.repeatRule === "once" ? "" : `（${parsed?.repeatLabel || repeatRuleLabel(item.repeatRule)}）`;
    return `${index + 1}. ${formatReminderTime(item.scheduledAt, item.timezone)} ${item.title}${repeat}`;
  });
  return `${items.length > 1 ? `已创建 ${items.length} 条提醒` : "已创建提醒"}：\n${lines.join("\n")}`;
}

async function rememberClarification(binding: Binding, originalInput: string, messageId: string) {
  await db.insert(pendingInboundClarifications).values({
    userId: binding.userId,
    originalInput,
    sourceMessageId: messageId,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  }).onConflictDoUpdate({
    target: pendingInboundClarifications.userId,
    set: { originalInput, sourceMessageId: messageId, expiresAt: new Date(Date.now() + 30 * 60_000), createdAt: new Date() },
  });
}

const MENU_CLARIFICATION_VALUE = "__numbered_menu__";

async function showNumberedMenu(binding: Binding, message: ILinkInboundMessage) {
  await rememberClarification(binding, MENU_CLARIFICATION_VALUE, sourceMessageId(binding, message));
  return reply(binding, message, HELP_TEXT, { showMembership: true });
}

const EDIT_CLARIFICATION_PREFIX = "__edit_clarification__:";
const CANCEL_CLARIFICATION_PREFIX = "__cancel_clarification__:";

type PendingEditClarification = {
  stage: "target" | "time";
  edit: ReminderEditCommand;
  candidateIds?: string[];
  reminderId?: string;
  prompt: string;
};

type PendingCancelClarification = {
  target: string;
  candidateIds: string[];
  prompt: string;
};

function parsePendingEditClarification(value: string) {
  if (!value.startsWith(EDIT_CLARIFICATION_PREFIX)) return null;
  try {
    return JSON.parse(value.slice(EDIT_CLARIFICATION_PREFIX.length)) as PendingEditClarification;
  } catch {
    return null;
  }
}

function parsePendingCancelClarification(value: string) {
  if (!value.startsWith(CANCEL_CLARIFICATION_PREFIX)) return null;
  try {
    return JSON.parse(value.slice(CANCEL_CLARIFICATION_PREFIX.length)) as PendingCancelClarification;
  } catch {
    return null;
  }
}

function parsePendingListContext(value: string) {
  if (!value.startsWith(LIST_CLARIFICATION_PREFIX)) return null;
  try {
    return JSON.parse(value.slice(LIST_CLARIFICATION_PREFIX.length)) as PendingListContext;
  } catch {
    return null;
  }
}

function parsePendingCreateClarification(value: string) {
  if (!value.startsWith(CREATE_CLARIFICATION_PREFIX)) return null;
  try {
    return JSON.parse(value.slice(CREATE_CLARIFICATION_PREFIX.length)) as PendingCreateClarification;
  } catch {
    return null;
  }
}

async function rememberCreateClarification(binding: Binding, clarification: PendingCreateClarification, messageId: string) {
  await rememberClarification(binding, `${CREATE_CLARIFICATION_PREFIX}${JSON.stringify(clarification)}`, messageId);
}

async function rememberListContext(binding: Binding, context: PendingListContext, messageId: string) {
  await rememberClarification(binding, `${LIST_CLARIFICATION_PREFIX}${JSON.stringify(context)}`, messageId);
}

async function rememberEditClarification(binding: Binding, clarification: PendingEditClarification, messageId: string) {
  await rememberClarification(binding, `${EDIT_CLARIFICATION_PREFIX}${JSON.stringify(clarification)}`, messageId);
}

async function rememberCancelClarification(binding: Binding, clarification: PendingCancelClarification, messageId: string) {
  await rememberClarification(binding, `${CANCEL_CLARIFICATION_PREFIX}${JSON.stringify(clarification)}`, messageId);
}

async function resolvePendingClarification(binding: Binding, message: ILinkInboundMessage, text: string) {
  const [pending] = await db.select().from(pendingInboundClarifications).where(and(
    eq(pendingInboundClarifications.userId, binding.userId),
    gt(pendingInboundClarifications.expiresAt, new Date()),
  )).limit(1);
  if (!pending) return false;
  const pendingEdit = parsePendingEditClarification(pending.originalInput);
  const pendingCancel = parsePendingCancelClarification(pending.originalInput);
  const pendingList = parsePendingListContext(pending.originalInput);
  const pendingCreate = parsePendingCreateClarification(pending.originalInput);
  const pendingMenu = pending.originalInput === MENU_CLARIFICATION_VALUE;
  const pendingCancelAll = pending.originalInput === CANCEL_ALL_CONFIRMATION_VALUE;
  if (/^(取消|算了|不用了)[!！。]?$/.test(text)) {
    await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
    await reply(binding, message, pendingEdit || pendingList?.action === "edit" ? "好的，已取消这次修改，原提醒保持不变。" : pendingCancel || pendingList?.action === "cancel" || pendingCancelAll ? "好的，已放弃取消，原提醒保持不变。" : pendingMenu ? "好的，已退出菜单。你仍然可以直接告诉我提醒事项。" : "好的，已取消这次创建。你可以随时重新告诉我提醒事项。");
    return true;
  }
  if (pendingCancelAll) {
    if (/^(?:确认|确定)(?:全部)?取消[!！。]?$/.test(text)) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      await cancelAllReminders(binding, message, true);
      return true;
    }
    await reply(binding, message, "这是不可恢复的批量操作。确定全部取消请回复“确认取消”，保留提醒请回复“算了”。");
    return true;
  }
  if (pendingMenu) {
    const choice = parseNumberedMenuChoice(text);
    if (choice === null) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      return false;
    }
    await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
    if (choice === 0) return showNumberedMenu(binding, message);
    if (choice === 1) return reply(binding, message, "请直接告诉我时间和事项。\n例如：“明天上午8点提醒我喝水”，也可以在一条消息里安排多个提醒。");
    if (choice === 2) return listReminders(binding, message, "view");
    if (choice === 3) return listReminders(binding, message, "edit");
    if (choice === 4) return listReminders(binding, message, "cancel");
    if (choice === 5) return reply(binding, message, "暂停重复提醒：发送“暂停提醒2”\n恢复提醒：发送“恢复提醒2”\n发送“查看暂停提醒”可以查看已暂停事项。");
    return cancelAllReminders(binding, message);
  }
  if (pendingList) {
    if (/^(下一页|下页|往后)[!！。]?$/.test(text)) return listReminders(binding, message, pendingList.action, pendingList.page + 1, pendingList.ids);
    if (/^(上一页|上页|往前)[!！。]?$/.test(text)) return listReminders(binding, message, pendingList.action, pendingList.page - 1, pendingList.ids);

    const visibleIds = pendingList.ids.slice(pendingList.page * LIST_PAGE_SIZE, (pendingList.page + 1) * LIST_PAGE_SIZE);
    const directCancel = parseReminderCancelCommand(text);
    const directEdit = parseReminderEditCommand(text);
    const directState = parseReminderStateCommand(text);
    if (directCancel) {
      const index = parseReminderCandidateChoice(directCancel.target, visibleIds.length);
      if (index !== null) {
        await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
        await cancelReminder(binding, message, directCancel.target, visibleIds[index]);
        return true;
      }
    }
    if (directEdit) {
      const index = parseReminderCandidateChoice(directEdit.target, visibleIds.length);
      if (index !== null) {
        await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
        await editReminder(binding, message, directEdit, visibleIds[index]);
        return true;
      }
    }
    if (directState) {
      const index = parseReminderCandidateChoice(directState.target, visibleIds.length);
      if (index !== null) {
        await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
        await changeRecurringReminderState(binding, message, directState.action, String(index + 1), visibleIds[index]);
        return true;
      }
    }

    if (pendingList.stage === "edit_value" && pendingList.reminderId) {
      const value = text.replace(/^(?:改到|改成|修改为|新时间[:：]?|新内容[:：]?)/, "").trim();
      const edit = /^(?:新内容|内容)[:：]/.test(text)
        ? { target: "", titleText: value.replace(/^(?:新内容|内容)[:：]?/, "").trim() }
        : { target: "", timeText: value };
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      await editReminder(binding, message, edit, pendingList.reminderId);
      return true;
    }

    const choice = parseReminderCandidateChoice(text, visibleIds.length);
    if (choice !== null) {
      const reminderId = visibleIds[choice];
      if (pendingList.action === "cancel") {
        await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
        await cancelReminder(binding, message, String(choice + 1), reminderId);
        return true;
      }
      if (pendingList.action === "edit") {
        await rememberListContext(binding, { ...pendingList, stage: "edit_value", reminderId }, sourceMessageId(binding, message));
        await reply(binding, message, `已选中第 ${choice + 1} 条。\n请回复新时间，例如“明天下午3点”；也可以回复“新内容：陪妈妈散步”。`);
        return true;
      }
      const [selected] = await db.select({ title: reminders.title, scheduledAt: reminders.scheduledAt, repeatRule: reminders.repeatRule }).from(reminders).where(and(eq(reminders.id, reminderId), eq(reminders.userId, binding.userId))).limit(1);
      if (selected) await reply(binding, message, `第 ${choice + 1} 条是：${formatReminderTime(selected.scheduledAt, "Asia/Shanghai")} ${selected.title}${selected.repeatRule === "once" ? "" : `（${repeatRuleLabel(selected.repeatRule)}）`}。`);
      return true;
    }
    if (directCancel || directEdit || directState) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      return false;
    }
    if (/(?:\d{1,2}|[零一二两三四五六七八九十]+)点|分钟后|小时后|今天|明天|后天|每天|工作日|每周|每月|早上|上午|中午|下午|晚上|今晚|明早|明晚|饭后|下班后|到家后|起床后|睡前/.test(text)) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      return false;
    }
    await reply(binding, message, pendingList.action === "view" ? "请回复提醒序号，或说“下一页”“取消提醒2”“把提醒2改到晚上8点”。" : "我还不能确定你选的是哪一条，请直接回复序号。回复“算了”可以退出。");
    return true;
  }
  if (pendingCancel) {
    const followupCancel = parseReminderCancelCommand(text);
    const selectionText = followupCancel?.target ?? text;
    const ids = pendingCancel.candidateIds;
    const rows = ids.length ? await db.select({ id: reminders.id, title: reminders.title }).from(reminders).where(and(
      eq(reminders.userId, binding.userId),
      eq(reminders.status, "upcoming"),
      inArray(reminders.id, ids),
    )) : [];
    const ordered = ids.map((id) => rows.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const choice = parseReminderCandidateChoice(selectionText, ordered.length);
    const titleMatches = reminderTargetMatches(ordered, selectionText);
    const selected = choice === null ? (titleMatches.length === 1 ? titleMatches[0] : null) : ordered[choice];
    if (!selected) {
      if (followupCancel) {
        await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
        return false;
      }
      await reply(binding, message, `${pendingCancel.prompt}\n我还不能确定你选的是哪一条，请直接回复序号。`);
      return true;
    }
    await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
    await cancelReminder(binding, message, pendingCancel.target, selected.id);
    return true;
  }
  if (pendingEdit) {
    if (parseReminderEditCommand(text) || /^取消提醒/.test(text)) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      return false;
    }
    if (pendingEdit.stage === "target") {
      const ids = pendingEdit.candidateIds ?? [];
      const rows = ids.length ? await db.select({ id: reminders.id, title: reminders.title }).from(reminders).where(and(
        eq(reminders.userId, binding.userId),
        eq(reminders.status, "upcoming"),
        inArray(reminders.id, ids),
      )) : [];
      const ordered = ids.map((id) => rows.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      const choice = parseReminderCandidateChoice(text, ordered.length);
      const titleMatches = reminderTargetMatches(ordered, text);
      const selected = choice === null ? (titleMatches.length === 1 ? titleMatches[0] : null) : ordered[choice];
      if (!selected) {
        await reply(binding, message, `${pendingEdit.prompt}\n我还不能确定你选的是哪一条，请直接回复序号。`);
        return true;
      }
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      await editReminder(binding, message, pendingEdit.edit, selected.id);
      return true;
    }

    const mergedTime = mergeReminderEditTimeClarification(pendingEdit.edit.timeText ?? "", text);
    if (!mergedTime || !pendingEdit.reminderId) {
      await reply(binding, message, `${pendingEdit.prompt}\n我还需要一个完整的钟点，例如“晚上8点”或“明天下午3点”。`);
      return true;
    }
    await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
    await editReminder(binding, message, { ...pendingEdit.edit, timeText: mergedTime, titleText: undefined }, pendingEdit.reminderId);
    return true;
  }
  if (pendingCreate) {
    if (parseReminderCancelCommand(text) || parseReminderEditCommand(text) || parseReminderStateCommand(text) || isListCommand(text) || isPausedListCommand(text)) {
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      return false;
    }
    if (pendingCreate.reason === "missing_title" && pendingCreate.parsed) {
      const title = text.replace(/^(?:提醒我|内容是|事项是)\s*/, "").replace(/[。.!！?？]+$/, "").trim().slice(0, 100);
      if (!isSpecificReminderTitle(title)) {
        await reply(binding, message, `${pendingCreate.prompt}\n“那个事”或“到时候再说”还不够具体，请回复例如“吃药”或“给妈妈打电话”。`);
        return true;
      }
      const parsed = { ...pendingCreate.parsed, title };
      const items = await createParsedReminders(binding, message, pendingCreate.originalInput, [parsed], ":clarified-title");
      await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
      await reply(binding, message, createdReminderResponse(items, [parsed]));
      return true;
    }
    if (pendingCreate.reason === "unsupported_repeat") {
      const supported = text.match(/每天|工作日|每周[一二三四五六日天]|每月(?:\d{1,2})(?:日|号)/)?.[0];
      if (supported) {
        const normalized = pendingCreate.originalInput
          .replace(/每隔\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:分钟|小时)/, supported)
          .replace(/每(?:周|星期)[一二三四五六日天]{2,}/, supported);
        const next = parseChineseReminders(normalized);
        if (next.reminders.length && !next.clarification) {
          const items = await createParsedReminders(binding, message, normalized, next.reminders, ":clarified-repeat");
          await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
          await reply(binding, message, createdReminderResponse(items, next.reminders));
          return true;
        }
        await rememberCreateClarification(binding, { originalInput: normalized, reason: "missing_exact_time", prompt: `好的，改为“${supported}”。还需要一个准确钟点，例如“早上8点”。` }, sourceMessageId(binding, message));
        await reply(binding, message, `好的，改为“${supported}”。还需要一个准确钟点，例如“早上8点”。`);
        return true;
      }
      await reply(binding, message, `${pendingCreate.prompt}\n你可以重新说一个支持的规则，或回复“取消”。`);
      return true;
    }
    const step = resolveReminderClarificationStep(pendingCreate.originalInput, text);
    if (step.clarification) {
      await rememberCreateClarification(binding, { ...pendingCreate, reason: step.clarification.reason, prompt: step.clarification.prompt }, sourceMessageId(binding, message));
      await reply(binding, message, `${step.clarification.prompt}\n之前已经确认的信息我会保留。回复“取消”可以放弃这次创建。`);
      return true;
    }
    const parsed = step.reminder;
    if (!parsed) {
      await reply(binding, message, "我还需要一个准确时间，例如“下午4点”或“明天上午9点”。回复“取消”可以放弃这次创建。");
      return true;
    }
    if (parsed.title === "新提醒") {
      const prompt = `时间我记住了：${formatReminderTime(new Date(parsed.scheduledAt), "Asia/Shanghai")}。要提醒你做什么？`;
      await rememberCreateClarification(binding, { originalInput: pendingCreate.originalInput, reason: "missing_title", prompt, parsed }, sourceMessageId(binding, message));
      await reply(binding, message, `${prompt}\n例如回复“吃药”或“给妈妈打电话”。回复“取消”可以放弃这次创建。`);
      return true;
    }
    const items = await createParsedReminders(binding, message, pendingCreate.originalInput, [parsed], ":clarified");
    await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
    await reply(binding, message, createdReminderResponse(items, [parsed]));
    return true;
  }
  const step = resolveReminderClarificationStep(pending.originalInput, text);
  if (step.clarification) {
    await rememberCreateClarification(binding, step.clarification, sourceMessageId(binding, message));
    await reply(binding, message, `${step.clarification.prompt}\n之前已经确认的信息我会保留。回复“取消”可以放弃这次创建。`);
    return true;
  }
  const parsed = step.reminder;
  if (!parsed) {
    await reply(binding, message, "我还需要一个准确时间，例如“下午4点”或“明天上午9点”。回复“取消”可以放弃这次创建。");
    return true;
  }
  if (parsed.title === "新提醒") {
    const prompt = `时间我记住了：${formatReminderTime(new Date(parsed.scheduledAt), "Asia/Shanghai")}。要提醒你做什么？`;
    await rememberCreateClarification(binding, { originalInput: pending.originalInput, reason: "missing_title", prompt, parsed }, sourceMessageId(binding, message));
    await reply(binding, message, `${prompt}\n例如回复“吃药”或“给妈妈打电话”。回复“取消”可以放弃这次创建。`);
    return true;
  }
  const items = await createParsedReminders(binding, message, pending.originalInput, [parsed], ":clarified");
  await db.delete(pendingInboundClarifications).where(eq(pendingInboundClarifications.userId, binding.userId));
  await reply(binding, message, createdReminderResponse(items, [parsed]));
  return true;
}

async function createReminder(binding: Binding, message: ILinkInboundMessage, text: string, responsePrefix?: string) {
  const messageId = sourceMessageId(binding, message);
  const previousResponse = await previousCommandResponse(binding.userId, messageId);
  if (previousResponse) return reply(binding, message, previousResponse);
  const batch = parseChineseReminders(text);
  const items = await createParsedReminders(binding, message, text, batch.reminders);
  let responseText = items.length ? createdReminderResponse(items, batch.reminders) : "";
  if (batch.clarification) {
    const baseParsed = batch.clarification.reason === "missing_title" ? parseChineseReminder(batch.clarification.originalInput) ?? undefined : undefined;
    await rememberCreateClarification(binding, { ...batch.clarification, parsed: baseParsed }, messageId);
    responseText = `${responseText ? `${responseText}\n\n` : ""}${batch.clarification.prompt}\n回复“取消”可以放弃这次创建。`;
  }
  if (responsePrefix && responseText) responseText = `${responsePrefix}\n${responseText}`;
  if (!responseText) responseText = HELP_TEXT;
  await saveCommandReceipt(binding.userId, items[0]?.id || null, messageId, "create", responseText);
  return reply(binding, message, responseText);
}

function operationalIntentReply(text: string) {
  if (/^(?:帮我)?(?:取消|删除|删掉|清空|移除|不要|别)(?:提醒|掉|一下|我的)?/.test(text)) return "我知道你想取消提醒，但还不能确定是哪一条。请说“取消喝水”，或先发送“查看提醒”再按序号取消。";
  if (/^(?:帮我)?(?:修改|更改|调整)|^把.+(?:改到|改成|调到|挪到|推迟)/.test(text)) return "我知道你想修改提醒，但还缺少目标或新内容。请说“把散步改到晚上8点”，或先发送“查看提醒”。";
  if (/^(?:帮我)?(?:暂停|停用|恢复|启用|继续提醒)/.test(text)) return "我知道你想暂停或恢复提醒，但还不能确定是哪一条。请说“暂停喝水”或“恢复喝水提醒”。";
  if (/^(?:帮我)?(?:查看|查询|看看)|^(?:我)?(?:还有|接下来).*(?:提醒|日程|安排)/.test(text)) return "你是想查看现有提醒吗？回复“查看提醒”，我会按序号列出来。";
  return null;
}

function aiClarification(reason: string | null) {
  if (reason === "missing_time" || reason === "unsupported_time") return "我知道要安排什么了，但还需要一个准确时间，例如“明天下午3点”。";
  if (reason === "missing_title") return "时间我记住了。要提醒你做什么？";
  if (reason === "missing_target") return "我知道你想修改或取消提醒，但还不能确定是哪一条。请补充事项名称，或先发送“查看提醒”。";
  return "这句话可能有不止一种理解。请补充具体事项和准确时间，我确认后再操作。";
}

async function tryAiIntent(binding: Binding, message: ILinkInboundMessage, text: string) {
  const user = await quotaUser(binding.userId);
  if (!user || user.accountStatus === "disabled") throw new Error("ACCOUNT_DISABLED");
  const candidates = await db.select({ id: reminders.id, title: reminders.title, scheduledAt: reminders.scheduledAt, repeatRule: reminders.repeatRule }).from(reminders)
    .where(and(eq(reminders.userId, binding.userId), inArray(reminders.status, ["upcoming", "paused"])))
    .orderBy(asc(reminders.scheduledAt)).limit(5);
  if (isReminderDomainMessage(text) || shouldUseAiForConversationalReminder(text)) {
    await reply(binding, message, "我正在确认这句话里的提醒意图，请稍等。", { idempotencySuffix: "ai-thinking" });
  }
  const intent = await analyzeReminderIntent({ user, text, timezone: user.timezone, reminders: candidates });
  if (!intent) return false;
  const targetChoice = intent.target ? parseReminderCandidateChoice(intent.target, candidates.length) : null;
  const resolvedTarget = targetChoice == null ? (intent.target || (intent.intent === "complete" ? candidates[0]?.title : "")) : candidates[targetChoice]?.title || intent.target || "";
  const resolvedTargetId = targetChoice == null ? undefined : candidates[targetChoice]?.id;
  if (intent.intent === "list") await listReminders(binding, message);
  else if (intent.intent === "cancel" && resolvedTarget) await cancelReminder(binding, message, resolvedTarget, resolvedTargetId);
  else if (intent.intent === "edit" && resolvedTarget && (intent.time_text || intent.title)) await editReminder(binding, message, { target: resolvedTarget, timeText: intent.time_text || undefined, titleText: intent.title || undefined }, resolvedTargetId);
  else if (intent.intent === "pause" && resolvedTarget) await changeRecurringReminderState(binding, message, "pause", resolvedTarget, resolvedTargetId);
  else if (intent.intent === "resume" && resolvedTarget) await changeRecurringReminderState(binding, message, "resume", resolvedTarget, resolvedTargetId);
  else if (intent.intent === "complete" && resolvedTarget) await completeReminder(binding, message, resolvedTarget, resolvedTargetId);
  else if (intent.intent === "create" && intent.title && intent.time_text) {
    const repeatText = intent.repeat === "daily" ? `每天${intent.repeat_days ? `连续${intent.repeat_days}天` : ""}` : intent.repeat === "weekdays" ? "每个工作日" : "";
    const title = cleanAiReminderTitle(intent.title, intent.time_text);
    await createReminder(binding, message, `${repeatText}${intent.time_text}提醒我${title}`, intent.correction_note ? `我把这句话理解为：${intent.correction_note}` : undefined);
  } else if (intent.intent === "clarify" && intent.clarification_reason === "missing_time" && intent.title) {
    await rememberCreateClarification(binding, { originalInput: `提醒我${intent.title}`, reason: "missing_exact_time", prompt: `我知道要提醒你“${intent.title}”，还差准确时间，例如“晚上8点”。` }, sourceMessageId(binding, message));
    await reply(binding, message, `我知道要提醒你“${intent.title}”，还差准确时间，例如“晚上8点”。`);
  } else if (intent.intent === "unsupported") {
    await reply(binding, message, "我是准点提醒助手，只能帮你创建、修改、取消、查询、暂停、恢复或完成提醒，不能处理其他问题。发送“菜单”可以查看用法。");
  } else await reply(binding, message, aiClarification(intent.clarification_reason));
  return true;
}

async function undoLatestCreate(binding: Binding, message: ILinkInboundMessage) {
  const [receipt] = await db.select({ reminderId: inboundCommandReceipts.reminderId }).from(inboundCommandReceipts)
    .where(and(eq(inboundCommandReceipts.userId, binding.userId), eq(inboundCommandReceipts.commandType, "create"), gt(inboundCommandReceipts.createdAt, new Date(Date.now() - 15 * 60_000))))
    .orderBy(desc(inboundCommandReceipts.createdAt)).limit(1);
  if (!receipt?.reminderId) return reply(binding, message, "我还没有找到最近可以撤销的创建操作。请告诉我具体要取消哪条提醒。");
  const [cancelled] = await db.update(reminders).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(reminders.id, receipt.reminderId), eq(reminders.userId, binding.userId), eq(reminders.status, "upcoming"))).returning({ id: reminders.id, title: reminders.title, queueJobId: reminders.queueJobId });
  if (!cancelled) return reply(binding, message, "这条提醒已经不在待提醒列表里了。发送“查看提醒”可以确认当前状态。");
  await cancelScheduledReminder(cancelled.queueJobId).catch(() => undefined);
  return reply(binding, message, `已撤销刚才创建的提醒：${cancelled.title}`);
}

async function handleMessage(binding: Binding, message: ILinkInboundMessage) {
  const text = messageText(message);
  if (!text || !message.from_user_id || message.from_user_id !== binding.weixinUserId) return;
  try {
    const account = await quotaUser(binding.userId);
    if (!account || account.accountStatus === "disabled") throw new Error("ACCOUNT_DISABLED");
    if (/^(你好|hi|hello|帮助|怎么用|菜单)[!！。]?$/i.test(text)) return showNumberedMenu(binding, message);
    if (/^(?:我的)?(?:会员|VIP)(?:状态|信息)?[!！。]?$/i.test(text)) {
      return reply(binding, message, "这是你当前的会员状态。", { showMembership: true });
    }
    if (/^(?:取消|清空|删除|删掉|移除)(?:我的)?(?:全部|所有)提醒[!！。]?$/.test(text)) return cancelAllReminders(binding, message);
    if (/^(?:撤销|撤回|改错了|不是这个意思)[!！。?？]?$/.test(text)) return undoLatestCreate(binding, message);
    if (isPausedListCommand(text)) return listPausedReminders(binding, message);
    if (isListCommand(text)) return listReminders(binding, message);
    if (await resolvePendingClarification(binding, message, text)) return;
    if (shouldUseAiForConversationalReminder(text) && await tryAiIntent(binding, message, text)) return;
    const cancel = parseReminderCancelCommand(text);
    if (cancel) return cancelReminder(binding, message, cancel.target);
    const edit = parseReminderEditCommand(text);
    if (edit) return editReminder(binding, message, edit);
    const stateCommand = parseReminderStateCommand(text);
    if (stateCommand) return changeRecurringReminderState(binding, message, stateCommand.action, stateCommand.target);
    const snooze = parseReminderSnoozeCommand(text);
    if (snooze) return snoozeLatestReminder(binding, message, text, new Date(snooze.scheduledAt));
    const completion = text.match(/^(?:完成|做完|已经)(.+?)(?:了)?[!！。]?$/);
    if (completion?.[1]?.trim()) return completeReminder(binding, message, completion[1].trim());
    const batch = parseChineseReminders(text);
    if (batch.reminders.length || batch.clarification?.reason !== "unrecognized") return createReminder(binding, message, text);
    if (text.length <= 120 && await tryAiIntent(binding, message, text)) return;
    const intentReply = operationalIntentReply(text);
    if (intentReply) return reply(binding, message, intentReply);
    return reply(binding, message, isReminderDomainMessage(text) ? "我还没理解这条提醒。请带上准确时间和事项，例如“明天下午3点提醒我回电话”。" : "我只能帮你管理提醒。发送“菜单”可以查看我能做什么。");
  } catch (error) {
    const limitMessage = reminderLimitFailureMessage(error);
    if (limitMessage) return await reply(binding, message, limitMessage);
    if (error instanceof Error && error.message === "ACCOUNT_DISABLED") return reply(binding, message, "当前账号已被停用，请联系管理员。");
    console.error("Failed to handle inbound reminder command", { userId: binding.userId, error: error instanceof Error ? error.message : "UNKNOWN" });
    return reply(binding, message, "我没能确认刚才的操作是否完成。请先发送“查看提醒”，确认后再重试。");
  }
}

state.handleMessage = handleMessage;

async function pollBinding(bindingId: string) {
  while (state.started) {
    const [binding] = await db.select().from(wechatBindings).where(and(eq(wechatBindings.id, bindingId), eq(wechatBindings.status, "active"))).limit(1);
    if (!binding) return;
    try {
      const updates = await clawBotConnector.getUpdates({
        botToken: decryptSecret(binding.encryptedBotToken),
        baseUrl: binding.baseUrl,
        cursor: binding.getUpdatesBuf,
      });
      let received = false;
      for (const message of updates.messages) {
        if (message.message_type && message.message_type !== 1) continue;
        try {
          await (state.handleMessage ?? handleMessage)(binding, message);
        } catch (error) {
          const limitMessage = reminderLimitFailureMessage(error);
          console.error("Inbound message handling failed", { bindingId, messageId: sourceMessageId(binding, message), error: error instanceof Error ? error.message : "UNKNOWN" });
          await reply(binding, message, limitMessage || "这条消息处理失败了，但不会影响后续消息。请换一种说法再试一次。");
        }
        received = true;
      }
      await db.update(wechatBindings).set({
        getUpdatesBuf: updates.cursor,
        ...(received ? { lastInboundAt: new Date() } : {}),
        updatedAt: new Date(),
      }).where(and(eq(wechatBindings.id, binding.id), eq(wechatBindings.status, "active")));
    } catch (error) {
      const expired = error instanceof Error && error.message === "CLAWBOT_SESSION_EXPIRED";
      console.error("Weixin inbound polling failed", { bindingId, error: error instanceof Error ? error.message : "UNKNOWN" });
      if (expired) {
        await db.update(wechatBindings).set({ status: "expired", updatedAt: new Date() }).where(and(
          eq(wechatBindings.id, bindingId),
          eq(wechatBindings.status, "active"),
        ));
        return;
      }
      await sleep(5_000);
    }
  }
}

async function reconcileBindings() {
  while (state.started) {
    try {
      const active = await db.select({ id: wechatBindings.id }).from(wechatBindings).where(eq(wechatBindings.status, "active"));
      for (const binding of active) {
        if (state.loops.has(binding.id)) continue;
        const loop = pollBinding(binding.id).finally(() => state.loops.delete(binding.id));
        state.loops.set(binding.id, loop);
      }
    } catch (error) {
      console.error("Weixin inbound reconciliation failed", error instanceof Error ? error.message : "UNKNOWN");
    }
    await sleep(5_000);
  }
}

export function startInboundPolling() {
  if (state.started) return;
  state.started = true;
  void reconcileBindings();
  console.log("Weixin inbound polling is running");
}
