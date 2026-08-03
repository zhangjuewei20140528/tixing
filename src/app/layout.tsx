import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "准点 - 微信提醒助手",
  description: "一句话创建提醒，到点发送到微信。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
