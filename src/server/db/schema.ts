import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const reminderStatus = pgEnum("reminder_status", ["upcoming", "completed", "cancelled", "paused"]);
export const bindingStatus = pgEnum("binding_status", ["pending", "active", "offline", "expired", "revoked"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sent", "failed", "blocked"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").unique(),
  passwordHash: text("password_hash"),
  role: text("role").$type<"user" | "admin">().notNull().default("user"),
  accountStatus: text("account_status").$type<"active" | "disabled">().notNull().default("active"),
  vipType: text("vip_type").$type<"none" | "monthly" | "permanent">().notNull().default("none"),
  vipExpiresAt: timestamp("vip_expires_at", { withTimezone: true }),
  reminderLimitOverride: integer("reminder_limit_override"),
  phone: text("phone").unique(),
  displayName: text("display_name").notNull().default("新用户"),
  adminNote: text("admin_note"),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const otpChallenges = pgTable("otp_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumed: boolean("consumed").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("otp_phone_created_idx").on(table.phone, table.createdAt)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("session_user_idx").on(table.userId)]);

export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  originalInput: text("original_input").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  repeatRule: text("repeat_rule").notNull().default("once"),
  repeatUntil: timestamp("repeat_until", { withTimezone: true }),
  status: reminderStatus("status").notNull().default("upcoming"),
  queueJobId: text("queue_job_id"),
  sourceChannel: text("source_channel"),
  sourceMessageId: text("source_message_id"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("reminder_user_status_idx").on(table.userId, table.status), index("reminder_due_idx").on(table.scheduledAt), uniqueIndex("reminder_source_message_unique").on(table.sourceMessageId)]);

export const inboundCommandReceipts = pgTable("inbound_command_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reminderId: uuid("reminder_id").references(() => reminders.id, { onDelete: "set null" }),
  sourceMessageId: text("source_message_id").notNull().unique(),
  commandType: text("command_type").notNull(),
  responseText: text("response_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("inbound_receipt_user_created_idx").on(table.userId, table.createdAt)]);

export const pendingInboundClarifications = pgTable("pending_inbound_clarifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  originalInput: text("original_input").notNull(),
  sourceMessageId: text("source_message_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("pending_clarification_expiry_idx").on(table.expiresAt)]);

export const wechatBindings = pgTable("wechat_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  weixinUserId: text("weixin_user_id").notNull(),
  encryptedBotToken: text("encrypted_bot_token").notNull(),
  baseUrl: text("base_url").notNull(),
  status: bindingStatus("status").notNull().default("pending"),
  getUpdatesBuf: text("get_updates_buf").notNull().default(""),
  boundAt: timestamp("bound_at", { withTimezone: true }),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  lastSuccessfulSendAt: timestamp("last_successful_send_at", { withTimezone: true }),
  tokenVersion: integer("token_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("wechat_binding_user_unique").on(table.userId),
  uniqueIndex("wechat_account_unique").on(table.accountId),
  uniqueIndex("wechat_user_identity_unique").on(table.weixinUserId),
]);

export const bindingSessions = pgTable("wechat_binding_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  connectorSessionKey: text("connector_session_key").notNull(),
  connectorBaseUrl: text("connector_base_url").notNull().default("https://ilinkai.weixin.qq.com"),
  qrValue: text("qr_value").notNull(),
  pendingVerifyCode: text("pending_verify_code"),
  status: bindingStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("binding_session_user_idx").on(table.userId, table.createdAt)]);

export const wechatAuthSessions = pgTable("wechat_auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  connectorSessionKey: text("connector_session_key").notNull(),
  connectorBaseUrl: text("connector_base_url").notNull().default("https://ilinkai.weixin.qq.com"),
  qrValue: text("qr_value").notNull(),
  browserTokenHash: text("browser_token_hash").notNull(),
  pendingVerifyCode: text("pending_verify_code"),
  status: bindingStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("wechat_auth_session_expiry_idx").on(table.status, table.expiresAt)]);

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  reminderId: uuid("reminder_id").notNull().references(() => reminders.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  channel: text("channel").notNull().default("weixin-ilink"),
  accountId: text("account_id"),
  recipientId: text("recipient_id"),
  status: deliveryStatus("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(1),
  providerMessageId: text("provider_message_id"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  providerResponse: jsonb("provider_response"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  handledBy: uuid("handled_by").references(() => users.id, { onDelete: "set null" }),
  handlingNote: text("handling_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("delivery_reminder_idx").on(table.reminderId), index("delivery_status_idx").on(table.status, table.createdAt)]);

export const aiIntentUsages = pgTable("ai_intent_usages", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").$type<"success" | "rejected" | "failed">().notNull(),
  intent: text("intent"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("ai_intent_usage_user_created_idx").on(table.userId, table.createdAt), index("ai_intent_usage_created_idx").on(table.createdAt)]);

export const serviceHeartbeats = pgTable("service_heartbeats", {
  service: text("service").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  details: jsonb("details"),
});

export const systemSettings = pgTable("system_settings", {
  id: text("id").primaryKey().default("default"),
  accountRegistrationEnabled: boolean("account_registration_enabled").notNull().default(true),
  wechatRegistrationEnabled: boolean("wechat_registration_enabled").notNull().default(true),
  reminderCreationEnabled: boolean("reminder_creation_enabled").notNull().default(true),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  aiGlobalDailyLimit: integer("ai_global_daily_limit").notNull().default(3000),
  alertEmail: text("alert_email").notNull().default(""),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  summary: text("summary").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("admin_audit_created_idx").on(table.createdAt), index("admin_audit_actor_idx").on(table.actorUserId, table.createdAt)]);
