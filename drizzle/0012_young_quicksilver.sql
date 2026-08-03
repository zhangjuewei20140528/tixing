CREATE TABLE "wechat_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"connector_session_key" text NOT NULL,
	"connector_base_url" text DEFAULT 'https://ilinkai.weixin.qq.com' NOT NULL,
	"qr_value" text NOT NULL,
	"pending_verify_code" text,
	"status" "binding_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wechat_auth_sessions" ADD CONSTRAINT "wechat_auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wechat_auth_session_expiry_idx" ON "wechat_auth_sessions" USING btree ("status","expires_at");
