CREATE TABLE "ai_intent_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"intent" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"service" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "ai_intent_usages" ADD CONSTRAINT "ai_intent_usages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_intent_usage_user_created_idx" ON "ai_intent_usages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_intent_usage_created_idx" ON "ai_intent_usages" USING btree ("created_at");
