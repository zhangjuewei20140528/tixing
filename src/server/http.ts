import { NextResponse } from "next/server";

export function apiError(error: unknown) {
  if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (error instanceof Error && error.message === "ACCOUNT_DISABLED") return NextResponse.json({ error: "账号已被禁用" }, { status: 403 });
  if (error instanceof Error && error.message === "FORBIDDEN") return NextResponse.json({ error: "没有管理员权限" }, { status: 403 });
  console.error(error);
  return NextResponse.json({ error: "服务器暂时无法处理请求" }, { status: 500 });
}
