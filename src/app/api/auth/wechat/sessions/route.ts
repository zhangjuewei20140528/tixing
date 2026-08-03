import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { clawBotConnector } from "@/server/clawbot";
import { db } from "@/server/db";
import { wechatAuthSessions } from "@/server/db/schema";
import { apiError } from "@/server/http";

const attempts = new Map<string, number[]>();

function allowRequest(request: Request) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const cutoff = Date.now() - 60_000;
  const recent = (attempts.get(key) || []).filter((value) => value > cutoff);
  if (recent.length >= 5) return false;
  recent.push(Date.now());
  attempts.set(key, recent);
  return true;
}

export async function POST(request: Request) {
  try {
    if (!allowRequest(request)) return NextResponse.json({ error: "操作太频繁，请一分钟后再试" }, { status: 429 });
    const started = await clawBotConnector.startBinding();
    const browserToken = randomBytes(32).toString("base64url");
    const [session] = await db.insert(wechatAuthSessions).values({
      connectorSessionKey: started.connectorSessionKey,
      connectorBaseUrl: started.baseUrl,
      qrValue: started.qrValue,
      browserTokenHash: createHash("sha256").update(browserToken).digest("hex"),
      expiresAt: new Date(started.expiresAt),
    }).returning({ id: wechatAuthSessions.id, qrValue: wechatAuthSessions.qrValue, expiresAt: wechatAuthSessions.expiresAt });
    const response = NextResponse.json({ session }, { status: 201 });
    response.cookies.set("wechat_auth_token", browserToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth/wechat/sessions",
      expires: session.expiresAt,
    });
    return response;
  } catch (error) {
    return apiError(error);
  }
}
