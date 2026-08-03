ALTER TABLE "wechat_binding_sessions" ADD COLUMN "connector_base_url" text DEFAULT 'https://ilinkai.weixin.qq.com' NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_binding_sessions" ADD COLUMN "pending_verify_code" text;
