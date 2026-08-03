export const MAX_AUTOMATIC_DELIVERY_ATTEMPTS = 6;

export type ExistingDeliveryStatus = "pending" | "sent" | "failed" | "blocked";
export type DeliveryAttemptDecision = "send" | "duplicate" | "handled" | "exhausted";

export function decideExistingDeliveryAttempt(input: {
  status: ExistingDeliveryStatus;
  attempt: number;
  handled: boolean;
  manualRetry: boolean;
}): DeliveryAttemptDecision {
  if (input.handled) return "handled";
  if (input.status === "sent" || input.status === "pending") return "duplicate";
  if (!input.manualRetry && input.attempt >= MAX_AUTOMATIC_DELIVERY_ATTEMPTS) return "exhausted";
  return "send";
}
