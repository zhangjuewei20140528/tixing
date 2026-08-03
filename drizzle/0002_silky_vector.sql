DROP INDEX "wechat_identity_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_account_unique" ON "wechat_bindings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_user_identity_unique" ON "wechat_bindings" USING btree ("weixin_user_id");
