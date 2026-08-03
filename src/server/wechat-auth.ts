import { createHash } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { encryptSecret } from "./crypto";
import { db } from "./db";
import { users, wechatBindings } from "./db/schema";
import { getSystemSettings } from "./system-settings";

type ConnectedWechat = {
  accountId: string;
  weixinUserId: string;
  botToken: string;
  baseUrl: string;
};

function generatedUsername(weixinUserId: string) {
  return `wx_${createHash("sha256").update(weixinUserId).digest("hex").slice(0, 24)}`;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

async function resolveWechatUserOnce(input: ConnectedWechat, registrationEnabled: boolean) {
  return db.transaction(async (tx) => {
    const [existingBinding] = await tx.select({ user: users }).from(wechatBindings)
      .innerJoin(users, eq(users.id, wechatBindings.userId))
      .where(or(eq(wechatBindings.weixinUserId, input.weixinUserId), eq(wechatBindings.accountId, input.accountId)))
      .limit(1);

    if (existingBinding) {
      if (existingBinding.user.accountStatus === "disabled") throw new Error("ACCOUNT_DISABLED");
      await tx.update(wechatBindings).set({
        accountId: input.accountId,
        weixinUserId: input.weixinUserId,
        encryptedBotToken: encryptSecret(input.botToken),
        baseUrl: input.baseUrl,
        status: "active",
        boundAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(wechatBindings.userId, existingBinding.user.id));
      return { user: existingBinding.user, created: false };
    }

    if (!registrationEnabled) throw new Error("WECHAT_REGISTRATION_DISABLED");

    const username = generatedUsername(input.weixinUserId);
    const [user] = await tx.insert(users).values({
      username,
      displayName: `微信用户${username.slice(-4)}`,
      role: "user",
    }).returning();
    await tx.insert(wechatBindings).values({
      userId: user.id,
      accountId: input.accountId,
      weixinUserId: input.weixinUserId,
      encryptedBotToken: encryptSecret(input.botToken),
      baseUrl: input.baseUrl,
      status: "active",
      boundAt: new Date(),
    });
    return { user, created: true };
  });
}

export async function resolveWechatUser(input: ConnectedWechat) {
  const registrationEnabled = (await getSystemSettings()).wechatRegistrationEnabled;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await resolveWechatUserOnce(input, registrationEnabled);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw new Error("WECHAT_ACCOUNT_RESOLUTION_FAILED");
}
