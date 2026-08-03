import { createHash, randomBytes } from "node:crypto";
import { retryTransient, runSerialized } from "@/lib/serialized-task";

const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.4.6";
const ILINK_APP_ID = "bot";
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

type QrStatus = "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
type BindingStart = { connectorSessionKey: string; qrValue: string; expiresAt: string; baseUrl: string };
type BindingPoll = { status: "waiting" | "scanned" | "connected" | "expired" | "verification" | "verification_blocked" | "already_bound"; accountId?: string; weixinUserId?: string; botToken?: string; baseUrl?: string; redirectBaseUrl?: string };
type DeliveryInput = { accountId: string; to: string; botToken: string; baseUrl: string; content: string; idempotencyKey: string; contextToken?: string };
export type ILinkInboundMessage = {
  message_id?: number | string;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>;
  context_token?: string;
};
type GetUpdatesResult = { messages: ILinkInboundMessage[]; cursor: string; timeoutMs: number };

function commonHeaders() {
  return { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION) };
}

function authenticatedHeaders(token?: string) {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    ...commonHeaders(),
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`${label}_INVALID_JSON`); }
}

export const clawBotConnector = {
  configured: () => true,

  async startBinding(): Promise<BindingStart> {
    const response = await fetch(`${LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ local_token_list: [] }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const data = await readJson<{ qrcode?: string; qrcode_img_content?: string }>(response, "CLAWBOT_QR");
    if (!data.qrcode || !data.qrcode_img_content) throw new Error("CLAWBOT_QR_INCOMPLETE");
    return { connectorSessionKey: data.qrcode, qrValue: data.qrcode_img_content, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), baseUrl: LOGIN_BASE_URL };
  },

  async pollBinding(key: string, baseUrl = LOGIN_BASE_URL, verifyCode?: string | null): Promise<BindingPoll> {
    const query = new URLSearchParams({ qrcode: key });
    if (verifyCode) query.set("verify_code", verifyCode);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/ilink/bot/get_qrcode_status?${query}`, {
      headers: commonHeaders(),
      signal: AbortSignal.timeout(35_000),
      cache: "no-store",
    });
    const data = await readJson<{ status: QrStatus; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string }>(response, "CLAWBOT_QR_STATUS");
    if (data.status === "confirmed") return { status: "connected", accountId: data.ilink_bot_id, weixinUserId: data.ilink_user_id, botToken: data.bot_token, baseUrl: data.baseurl || baseUrl };
    if (data.status === "scaned") return { status: "scanned" };
    if (data.status === "scaned_but_redirect") return { status: "scanned", redirectBaseUrl: data.redirect_host ? `https://${data.redirect_host}` : undefined };
    if (data.status === "need_verifycode") return { status: "verification" };
    if (data.status === "verify_code_blocked") return { status: "verification_blocked" };
    if (data.status === "binded_redirect") return { status: "already_bound" };
    if (data.status === "expired") return { status: "expired" };
    return { status: "waiting" };
  },

  async getUpdates(input: { botToken: string; baseUrl: string; cursor: string }): Promise<GetUpdatesResult> {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/ilink/bot/getupdates`, {
      method: "POST",
      headers: authenticatedHeaders(input.botToken),
      body: JSON.stringify({ get_updates_buf: input.cursor, base_info: { channel_version: CHANNEL_VERSION } }),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    const data = await readJson<{ ret?: number; errcode?: number; errmsg?: string; msgs?: ILinkInboundMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }>(response, "CLAWBOT_UPDATES");
    const code = data.ret ?? data.errcode ?? 0;
    if (code === -14) throw new Error("CLAWBOT_SESSION_EXPIRED");
    if (code !== 0) throw new Error(`CLAWBOT_UPDATES_${code}:${data.errmsg || "unknown"}`);
    return { messages: data.msgs ?? [], cursor: data.get_updates_buf ?? input.cursor, timeoutMs: data.longpolling_timeout_ms ?? 35_000 };
  },

  async send(input: DeliveryInput) {
    return runSerialized(input.accountId, () => retryTransient(
      () => sendMessage(input),
      (error) => error instanceof Error && /^CLAWBOT_SEND_-2(?::|$)/.test(error.message),
      [500, 1_000],
    ));
  },
};

async function sendMessage(input: DeliveryInput) {
  const clientId = `zhundian-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32)}`;
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/ilink/bot/sendmessage`, {
    method: "POST",
    headers: authenticatedHeaders(input.botToken),
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: input.to,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: input.content } }],
        ...(input.contextToken ? { context_token: input.contextToken } : {}),
      },
      base_info: { channel_version: CHANNEL_VERSION, bot_agent: "Zhundian/0.2.0" },
    }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const data = await readJson<{ ret?: number; errmsg?: string }>(response, "CLAWBOT_SEND");
  if (data.ret && data.ret !== 0) throw new Error(`CLAWBOT_SEND_${data.ret}:${data.errmsg || "unknown"}`);
  return { messageId: clientId, raw: { ret: data.ret ?? 0, accountId: input.accountId, idempotencyKey: input.idempotencyKey } };
}
