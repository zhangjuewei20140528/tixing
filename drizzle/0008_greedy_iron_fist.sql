CREATE TABLE "pending_inbound_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"original_input" text NOT NULL,
	"source_message_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_inbound_clarifications_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminder_limit_override" integer;--> statement-breakpoint
ALTER TABLE "pending_inbound_clarifications" ADD CONSTRAINT "pending_inbound_clarifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_clarification_expiry_idx" ON "pending_inbound_clarifications" USING btree ("expires_at");
