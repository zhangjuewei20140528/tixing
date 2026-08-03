import { nextFutureOccurrence } from "./reminder-schedule";

type DeliveryFinalizationInput = {
  status: "upcoming" | "completed" | "cancelled" | "paused";
  repeatRule: string;
  scheduledAt: Date;
  occurrenceAt: Date;
  repeatUntil?: Date | null;
};

export type DeliveryFinalization =
  | { kind: "complete" }
  | { kind: "advance"; scheduledAt: Date }
  | { kind: "noop" };

export function resolveDeliveryFinalization(input: DeliveryFinalizationInput, now = new Date()): DeliveryFinalization {
  if (input.status !== "upcoming" || input.scheduledAt.getTime() !== input.occurrenceAt.getTime()) return { kind: "noop" };
  if (input.repeatRule === "once") return { kind: "complete" };
  const scheduledAt = nextFutureOccurrence(input.occurrenceAt, input.repeatRule, now);
  if (scheduledAt && input.repeatUntil && scheduledAt > input.repeatUntil) return { kind: "complete" };
  return scheduledAt ? { kind: "advance", scheduledAt } : { kind: "noop" };
}
