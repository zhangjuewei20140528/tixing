ALTER TABLE "delivery_attempts" ADD COLUMN "handled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD COLUMN "handled_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD COLUMN "handling_note" text;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
