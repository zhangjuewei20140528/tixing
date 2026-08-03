import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/server/db";
import { users } from "../src/server/db/schema";

async function main() {
  const username = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const legacyPhone = (process.env.ADMIN_LEGACY_PHONE || process.env.ADMIN_PHONES?.split(",")[0] || "").trim();

  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new Error("ADMIN_USERNAME must contain 3-32 lowercase letters, numbers, or underscores");
  if (password.length < 12 || password.length > 72) throw new Error("ADMIN_PASSWORD must contain 12-72 characters");

  const [usernameOwner] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const [legacyUser] = legacyPhone ? await db.select().from(users).where(eq(users.phone, legacyPhone)).limit(1) : [];

  if (usernameOwner && legacyUser && usernameOwner.id !== legacyUser.id) throw new Error("ADMIN_USERNAME is already owned by another user");

  const passwordHash = await hash(password, 12);
  const target = usernameOwner || legacyUser;
  if (target) {
    await db.update(users).set({ username, passwordHash, role: "admin", updatedAt: new Date() }).where(eq(users.id, target.id));
    console.log(`Updated administrator account: ${username}`);
  } else {
    await db.insert(users).values({ username, passwordHash, role: "admin", displayName: "系统管理员" });
    console.log(`Created administrator account: ${username}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool?.end());
