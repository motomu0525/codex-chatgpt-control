import type { CommandResult } from "../types.js";
import type { ChatGPTCommandBlocker } from "./types.js";

const NEVER_AUTO_RESUME = new Set<ChatGPTCommandBlocker["kind"]>([
  "captcha",
  "login_required",
  "rate_limit",
  "verification_policy",
  "selector_drift",
  "artifact_selector_drift",
  "unknown"
]);

export type ResumeDecision =
  | { supported: true; stateId?: string }
  | { supported: false; reason: string };

export function resumeDecisionForBlocker(
  blocker: CommandResult["blocker"] | undefined,
  stateId?: string
): ResumeDecision {
  if (blocker === undefined) {
    return { supported: false, reason: "This result has no resumable browser-control blocker." };
  }

  if (NEVER_AUTO_RESUME.has(blocker.kind)) {
    return { supported: false, reason: "This blocker is not safe to resume automatically." };
  }

  if (blocker.resumable === true) {
    return stateId === undefined ? { supported: true } : { supported: true, stateId };
  }

  return { supported: false, reason: "The underlying browser-control command did not mark this blocker as resumable." };
}

export function augmentCommandBlocker(blocker: NonNullable<CommandResult["blocker"]>): ChatGPTCommandBlocker {
  const augmented: ChatGPTCommandBlocker = { ...blocker };
  if (augmented.resumable === undefined) {
    augmented.resumable = blocker.kind === "confirmation" || blocker.kind === "permission";
  }
  return augmented;
}
