import { db } from "./db";
import { adminAuditLogs } from "./db/schema";

export async function writeAdminAudit(input: {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
}) {
  await db.insert(adminAuditLogs).values({
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId || null,
    summary: input.summary,
    details: input.details || null,
  });
}
