import type { BlockerKind, CommandContext, CommandResult, ExistingTabDiagnostics, TemporaryChatDiagnostics } from "../types.js";
import { augmentCommandBlocker, resumeDecisionForBlocker, type ResumeDecision } from "../runner/resume.js";

type RemediationStep = NonNullable<NonNullable<CommandResult["blocker"]>["remediation"]>[number];
type VisibleCandidate = NonNullable<NonNullable<CommandResult["blocker"]>["candidates"]>[number];

export type BlockerSeverity = "info" | "warning" | "action_required" | "blocked";

export type BlockerCategory =
  | "environment"
  | "auth"
  | "permission"
  | "ui_drift"
  | "user_confirmation"
  | "targeting"
  | "runtime"
  | "not_found"
  | "artifact"
  | "download"
  | "upload"
  | "unknown";

export type BlockerRetryGuidance =
  | { safe: true; when: string; command?: string }
  | { safe: false; reason: string };

export type BlockerResumeGuidance =
  | { supported: true; stateId?: string; command?: string }
  | { supported: false; reason: string };

export type BlockerExplanation = {
  kind: string;
  code?: string;
  title: string;
  summary: string;
  severity: BlockerSeverity;
  category: BlockerCategory;
  userActionRequired: boolean;
  retry: BlockerRetryGuidance;
  resume: BlockerResumeGuidance;
  remediation: RemediationStep[];
  candidates?: VisibleCandidate[];
  context?: {
    command?: string;
    url?: string;
    conversationId?: string;
    tabId?: string;
  };
  diagnostics?: {
    existingTab?: ExistingTabDiagnostics;
    temporary?: TemporaryChatDiagnostics;
  };
  nextCommands: string[];
  markdown: string;
};

export type ExplainBlockerOptions = {
  command?: string;
  context?: Partial<CommandContext>;
  stateId?: string;
  nextCommands?: string[];
};

type Blocker = NonNullable<CommandResult["blocker"]>;

type BlockerProfile = {
  title: string;
  category: BlockerCategory;
  severity: BlockerSeverity;
  userActionRequired: boolean;
  defaultRetryReason: string;
  defaultRemediation?: RemediationStep[];
};

const PROFILES: Record<BlockerKind, BlockerProfile> = {
  browser_bridge_unavailable: {
    title: "Browser bridge unavailable",
    category: "environment",
    severity: "blocked",
    userActionRequired: false,
    defaultRetryReason: "Retry only after changing the execution environment or bootstrapping the Codex Chrome bridge."
  },
  login_required: {
    title: "Login required",
    category: "auth",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry after the user signs in to ChatGPT; do not auto-submit a prompt."
  },
  captcha: {
    title: "Captcha or human verification required",
    category: "auth",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry after the user completes the visible verification; do not auto-submit a prompt."
  },
  rate_limit: {
    title: "Rate limited",
    category: "auth",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry only after the usage window resets or the user selects a different safe path."
  },
  modal: {
    title: "Modal is blocking the page",
    category: "runtime",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry after the blocking modal is dismissed or handled."
  },
  permission: {
    title: "Permission required",
    category: "permission",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry after the reported permission setting changes and only if the command is safe to resume."
  },
  confirmation: {
    title: "Confirmation required",
    category: "user_confirmation",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry only after the user approves the exact bounded action."
  },
  verification_policy: {
    title: "Verification policy",
    category: "runtime",
    severity: "blocked",
    userActionRequired: false,
    defaultRetryReason: "Do not retry blindly; inspect the verification diagnostics and retry only after verified UI evidence is available."
  },
  selector_drift: {
    title: "Selector drift",
    category: "ui_drift",
    severity: "blocked",
    userActionRequired: false,
    defaultRetryReason: "Do not retry blindly; update selectors/localization or move the visible UI to a supported state."
  },
  artifact_unavailable: {
    title: "Artifact unavailable",
    category: "artifact",
    severity: "warning",
    userActionRequired: false,
    defaultRetryReason: "Retry only after the artifact appears or the command can safely re-check without resubmitting a prompt."
  },
  artifact_selector_drift: {
    title: "Artifact selector drift",
    category: "ui_drift",
    severity: "blocked",
    userActionRequired: false,
    defaultRetryReason: "Do not retry blindly; update artifact selectors before resuming."
  },
  artifact_download_unavailable: {
    title: "Artifact download unavailable",
    category: "download",
    severity: "warning",
    userActionRequired: false,
    defaultRetryReason: "Retry only after a download control appears, or use a safe visible asset fallback if the caller requested it."
  },
  download_unavailable: {
    title: "Download unavailable",
    category: "download",
    severity: "warning",
    userActionRequired: false,
    defaultRetryReason: "Retry only after a downloadable affordance appears; do not resubmit the prompt just to create one."
  },
  upload_failed: {
    title: "Upload failed",
    category: "upload",
    severity: "action_required",
    userActionRequired: true,
    defaultRetryReason: "Retry after the upload blocker is fixed and only if the prompt has not already been submitted."
  },
  not_found: {
    title: "Target not found",
    category: "not_found",
    severity: "warning",
    userActionRequired: false,
    defaultRetryReason: "Retry only after the target changes or the caller relaxes the targeting policy."
  },
  unknown: {
    title: "Unknown blocker",
    category: "unknown",
    severity: "blocked",
    userActionRequired: false,
    defaultRetryReason: "Inspect the structured blocker and retry only after the cause is understood."
  }
};

export function explainCommandBlocker(
  resultOrBlocker: CommandResult<unknown> | Blocker | undefined,
  options: ExplainBlockerOptions = {}
): BlockerExplanation {
  const result = isCommandResult(resultOrBlocker) ? resultOrBlocker : undefined;
  const rawBlocker = result?.blocker ?? (isBlocker(resultOrBlocker) ? resultOrBlocker : undefined);
  const blocker = rawBlocker === undefined ? undefined : augmentCommandBlocker(rawBlocker);
  const context = explanationContext(result?.context ?? options.context, options.command);

  if (blocker === undefined) {
    const explanation: Omit<BlockerExplanation, "markdown"> = {
      kind: "none",
      title: "No blocker",
      summary: "The command result does not include a browser-control blocker.",
      severity: "info",
      category: "unknown",
      userActionRequired: false,
      retry: { safe: false, reason: "There is no blocker-specific retry guidance." },
      resume: { supported: false, reason: "This result has no resumable browser-control blocker." },
      remediation: [],
      nextCommands: options.nextCommands ?? []
    };
    if (context !== undefined) explanation.context = context;
    return { ...explanation, markdown: renderMarkdown(explanation) };
  }

  const profile = PROFILES[blocker.kind as BlockerKind] ?? PROFILES.unknown;
  const resume = toResumeGuidance(resumeDecisionForBlocker(blocker, options.stateId), options.command);
  const retry = retryGuidance(blocker, profile, resume, options.command);
  const remediation = blocker.remediation ?? profile.defaultRemediation ?? [];
  const summary = summaryForBlocker(blocker);
  const base: Omit<BlockerExplanation, "markdown"> = {
    kind: blocker.kind,
    title: profile.title,
    summary,
    severity: profile.severity,
    category: categoryForBlocker(blocker, profile),
    userActionRequired: profile.userActionRequired || remediation.some(step => step.userActionRequired),
    retry,
    resume,
    remediation,
    nextCommands: options.nextCommands ?? defaultNextCommands(blocker, options.command, resume)
  };

  if (blocker.code !== undefined) base.code = blocker.code;
  if (context !== undefined) base.context = context;
  if (blocker.candidates !== undefined) base.candidates = blocker.candidates;
  if (blocker.diagnostics !== undefined) base.diagnostics = blocker.diagnostics;

  return { ...base, markdown: renderMarkdown(base) };
}

function isCommandResult(value: unknown): value is CommandResult<unknown> {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && "status" in value
    && "context" in value;
}

function isBlocker(value: unknown): value is Blocker {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && "message" in value;
}

function explanationContext(
  source: Partial<CommandContext> | undefined,
  command: string | undefined
): BlockerExplanation["context"] {
  const context: NonNullable<BlockerExplanation["context"]> = {};
  if (command !== undefined) context.command = command;
  if (source?.url !== undefined) context.url = source.url;
  if (source?.conversationId !== undefined) context.conversationId = source.conversationId;
  if (source?.tabId !== undefined) context.tabId = source.tabId;
  return Object.keys(context).length === 0 ? undefined : context;
}

function summaryForBlocker(blocker: Blocker): string {
  const code = blocker.code === undefined ? "" : ` (${blocker.code})`;
  return `${blocker.kind}${code}: ${blocker.message}`;
}

function categoryForBlocker(blocker: Blocker, profile: BlockerProfile): BlockerCategory {
  if (blocker.kind === "not_found" && blocker.code?.startsWith("existing_tab_") === true) {
    return "targeting";
  }
  return profile.category;
}

function retryGuidance(
  blocker: Blocker,
  profile: BlockerProfile,
  resume: BlockerResumeGuidance,
  command: string | undefined
): BlockerRetryGuidance {
  if (resume.supported) {
    const guidance: BlockerRetryGuidance = {
      safe: true,
      when: retryWhen(blocker)
    };
    if (command !== undefined) guidance.command = command;
    return guidance;
  }
  return { safe: false, reason: profile.defaultRetryReason };
}

function retryWhen(blocker: Blocker): string {
  switch (blocker.kind) {
    case "permission":
    case "upload_failed":
      return "After the reported permission/upload issue is fixed and before any duplicate prompt submission.";
    case "confirmation":
      return "After the user approves the exact bounded action.";
    case "download_unavailable":
    case "artifact_download_unavailable":
      return "After the download affordance appears without resubmitting the prompt.";
    default:
      return "After the blocker is resolved and the command remains safe to resume.";
  }
}

function toResumeGuidance(decision: ResumeDecision, command: string | undefined): BlockerResumeGuidance {
  if (!decision.supported) {
    return decision;
  }
  const supported: BlockerResumeGuidance = { supported: true };
  if (decision.stateId !== undefined) supported.stateId = decision.stateId;
  if (command !== undefined) supported.command = command;
  return supported;
}

function defaultNextCommands(blocker: Blocker, command: string | undefined, resume: BlockerResumeGuidance): string[] {
  if (blocker.kind === "browser_bridge_unavailable") return ["session.bootstrap"];
  if (blocker.kind === "not_found" && blocker.code?.startsWith("existing_tab_") === true) {
    return command === undefined ? [] : [command];
  }
  if (resume.supported && command !== undefined) return [command];
  return [];
}

function renderMarkdown(explanation: Omit<BlockerExplanation, "markdown">): string {
  const lines: string[] = [
    `### ${explanation.title}`,
    "",
    explanation.summary,
    "",
    `- Kind: \`${explanation.kind}\``
  ];
  if (explanation.code !== undefined) lines.push(`- Code: \`${explanation.code}\``);
  lines.push(`- Category: \`${explanation.category}\``);
  lines.push(`- Severity: \`${explanation.severity}\``);
  if (explanation.context?.command !== undefined) lines.push(`- Command: \`${explanation.context.command}\``);
  if (explanation.context?.url !== undefined) lines.push(`- URL: ${explanation.context.url}`);
  if (explanation.context?.conversationId !== undefined) lines.push(`- Conversation: \`${explanation.context.conversationId}\``);
  if (explanation.context?.tabId !== undefined) lines.push(`- Tab: \`${explanation.context.tabId}\``);

  lines.push("");
  if (explanation.retry.safe) {
    lines.push(`Retry: safe only ${explanation.retry.when}`);
  } else {
    lines.push(`Retry: ${explanation.retry.reason}`);
  }

  if (explanation.resume.supported) {
    const state = explanation.resume.stateId === undefined ? "" : ` with state \`${explanation.resume.stateId}\``;
    lines.push(`Resume: supported${state}.`);
  } else {
    lines.push(`Resume: ${explanation.resume.reason}`);
  }

  if (explanation.remediation.length > 0) {
    lines.push("", "Remediation:");
    for (const step of explanation.remediation) {
      lines.push(`- ${step.label}: ${step.instruction}`);
    }
  }

  if ((explanation.candidates?.length ?? 0) > 0) {
    lines.push("", "Candidates:");
    for (const candidate of explanation.candidates ?? []) {
      const role = candidate.role === undefined ? "" : ` (${candidate.role})`;
      lines.push(`- ${candidate.label}${role}`);
    }
  }

  const existingTab = explanation.diagnostics?.existingTab;
  if (existingTab !== undefined) {
    lines.push("", "Existing-tab diagnostics:");
    lines.push(`- Target: \`${existingTab.requestedTarget.type}\``);
    lines.push(`- Mismatch: \`${existingTab.mismatchReason}\``);
    lines.push(`- User-open tab enumeration: \`${existingTab.userOpenTabsAvailable ? "available" : "unavailable"}\``);
    lines.push(`- ChatGPT tabs seen: \`${existingTab.chatgptTabCount}\``);
    for (const tab of existingTab.candidateTabs) {
      lines.push(`- Candidate tab ${tab.id}: ${tab.title ?? "Untitled"} - ${tab.url ?? "unknown URL"}`);
    }
  }

  const temporary = explanation.diagnostics?.temporary;
  if (temporary !== undefined) {
    lines.push("", "Temporary Chat diagnostics:");
    lines.push(`- URL temporary parameter: \`${temporary.urlTemporaryParam ? "present" : "absent"}\``);
    if (temporary.turnCount !== undefined) lines.push(`- Turns: \`${temporary.turnCount}\``);
    if (temporary.assistantTurnCount !== undefined) lines.push(`- Assistant turns: \`${temporary.assistantTurnCount}\``);
    lines.push(`- Selector turn-off candidates: \`${temporary.selectorTurnOffCount}\``);
    lines.push(`- Selector turn-on candidates: \`${temporary.selectorTurnOnCount}\``);
    lines.push(`- Evaluate candidates: \`${temporary.evaluateCandidatesCount}\``);
    if (temporary.confidence !== undefined) lines.push(`- Confidence: \`${temporary.confidence}\``);
    if (temporary.reason !== undefined) lines.push(`- Reason: \`${temporary.reason}\``);
    if ((temporary.driftSnapshot?.length ?? 0) > 0) {
      lines.push("- Drift snapshot: present");
    }
  }

  return lines.join("\n");
}
