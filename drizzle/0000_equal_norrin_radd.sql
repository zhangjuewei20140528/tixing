CREATE TYPE "public"."binding_status" AS ENUM('pending', 'active', 'offline', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('upcoming', 'completed', 'cancelled', 'paused');--> statement-breakpoint
CREATE TABLE "wechat_binding_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_session_key" text NOT NULL,
	"qr_value" text NOT NULL,
	"status" "binding_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"channel" text DEFAULT 'openclaw-weixin' NOT NULL,
	"account_id" text,
	"recipient_id" text,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"provider_response" jsonb,
	"scheduled_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"original_input" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"repeat_rule" text DEFAULT 'once' NOT NULL,
	"status" "reminder_status" DEFAULT 'upcoming' NOT NULL,
	"queue_job_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"display_name" text DEFAULT '新用户' NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "wechat_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"weixin_user_id" text NOT NULL,
	"encrypted_bot_token" text NOT NULL,
	"base_url" text NOT NULL,
	"status" "binding_status" DEFAULT 'pending' NOT NULL,
	"bound_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_successful_send_at" timestamp with time zone,
	"token_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wechat_binding_sessions" ADD CONSTRAINT "wechat_binding_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_bindings" ADD CONSTRAINT "wechat_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "binding_session_user_idx" ON "wechat_binding_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_reminder_idx" ON "delivery_attempts" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "delivery_status_idx" ON "delivery_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "otp_phone_created_idx" ON "otp_challenges" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "reminder_user_status_idx" ON "reminders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "reminder_due_idx" ON "reminders" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_binding_user_unique" ON "wechat_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_identity_unique" ON "wechat_bindings" USING btree ("account_id","weixin_user_id");
