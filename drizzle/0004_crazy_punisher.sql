ALTER TABLE "reminders" ADD COLUMN "source_channel" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "wechat_bindings" ADD COLUMN "get_updates_buf" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_source_message_unique" ON "reminders" USING btree ("source_message_id");
