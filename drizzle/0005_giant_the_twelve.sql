CREATE TABLE "inbound_command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reminder_id" uuid,
	"source_message_id" text NOT NULL,
	"command_type" text NOT NULL,
	"response_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_command_receipts_source_message_id_unique" UNIQUE("source_message_id")
);
--> statement-breakpoint
ALTER TABLE "inbound_command_receipts" ADD CONSTRAINT "inbound_command_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_command_receipts" ADD CONSTRAINT "inbound_command_receipts_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_receipt_user_created_idx" ON "inbound_command_receipts" USING btree ("user_id","created_at");
