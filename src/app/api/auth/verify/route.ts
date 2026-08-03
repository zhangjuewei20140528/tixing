import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "短信验证码登录已停用，请使用账号密码" }, { status: 410 });
}
