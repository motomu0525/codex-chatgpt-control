import { resultOk } from "../errors.js";
import type {
  CommandContext,
  CommandResult,
  PageLike,
  RuntimeEnv,
  TemporaryChatData,
  TemporaryChatDiagnostics,
  TemporaryChatEvidence,
  TemporaryDriftSnapshotEntry
} from "../types.js";
import { withTimeout } from "../browser/evaluate.js";
import { contextFromPage } from "./context.js";
import { bootstrap } from "./session.js";

type TemporaryCandidate = {
  label: string;
  onEvidence: TemporaryChatEvidence[];
  offEvidence: TemporaryChatEvidence[];
  source: "selector" | "evaluate";
  kind: "turn-off" | "turn-on" | "unknown";
};

const TEMPORARY_TURN_ON_LABELS = [
  "一時チャットをオンにする",
  "Turn on temporary chat",
  "Turn on Temporary Chat"
];

const TEMPORARY_TURN_OFF_LABELS = [
  "一時チャットをオフにする",
  "Turn off temporary chat",
  "Turn off Temporary Chat"
];

export async function readTemporaryChatState(env: RuntimeEnv): Promise<CommandResult<TemporaryChatData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) {
    return boot as CommandResult<TemporaryChatData>;
  }

  const page = env.page!;
  const context = await contextFromPage(page);
  const emptyTemporaryUrl = isTemporaryUrlEmptyChat(context.url, context.turnCount, context.assistantTurnCount);

  if (emptyTemporaryUrl) {
    const selectorCandidates = await readTemporaryCandidatesBySelectors(page);
    if (selectorCandidates.length > 0) {
      return resultFromCandidates(selectorCandidates, context);
    }

    const textEvidence = await readTemporaryPageTextEvidence(page);
    if (textEvidence !== undefined) {
      const evidence = [
        { label: "Temporary Chat URL parameter", source: "url-param=temporary-chat=true" },
        textEvidence
      ];
      return resultOk({
        state: "on",
        confidence: "verified",
        evidence,
        candidates: [],
        diagnostics: temporaryDiagnostics(context, [], "verified")
      }, context);
    }

    const urlEvidence = [
      { label: "Temporary Chat URL parameter", source: "url-param=temporary-chat=true" },
      { label: "Empty ChatGPT thread", source: "empty-chat" }
    ];
    return resultOk({
      state: "on",
      confidence: "assumed_from_url",
      evidence: urlEvidence,
      candidates: [],
      diagnostics: temporaryDiagnostics(context, [], "assumed_from_url", "url_empty_chat_without_dom_signal")
    }, context);
  }

  const candidates = await readTemporaryCandidates(page);
  return resultFromCandidates(candidates, context);
}

function resultFromCandidates(candidates: TemporaryCandidate[], context: CommandContext): CommandResult<TemporaryChatData> {
  const labels = candidates.map(candidate => candidate.label);
  const evidence = candidates.flatMap(candidate => [...candidate.onEvidence, ...candidate.offEvidence]);
  const baseDiagnostics = temporaryDiagnostics(context, candidates);

  if (candidates.length !== 1) {
    return resultOk({ state: "unknown", evidence, candidates: labels, diagnostics: baseDiagnostics }, context);
  }

  const candidate = candidates[0]!;
  if (candidate.onEvidence.length >= 2) {
    const diagnostics = temporaryDiagnostics(context, candidates, "verified");
    return resultOk({
      state: "on",
      confidence: "verified",
      evidence: candidate.onEvidence,
      candidates: labels,
      diagnostics
    }, context);
  }

  if (candidate.offEvidence.length > 0 && candidate.onEvidence.length === 0) {
    return resultOk({ state: "off", evidence: candidate.offEvidence, candidates: labels, diagnostics: baseDiagnostics }, context);
  }

  return resultOk({ state: "unknown", evidence, candidates: labels, diagnostics: baseDiagnostics }, context);
}

function isTemporaryUrlEmptyChat(url: string | undefined, turnCount: number | undefined, assistantTurnCount: number | undefined): boolean {
  return typeof url === "string"
    && /[?&]temporary-chat=true\b/i.test(url)
    && turnCount === 0
    && assistantTurnCount === 0;
}

function temporaryDiagnostics(
  context: CommandContext,
  candidates: TemporaryCandidate[],
  confidence?: "verified" | "assumed_from_url",
  reason?: string
): TemporaryChatDiagnostics {
  return {
    urlTemporaryParam: typeof context.url === "string" && /[?&]temporary-chat=true\b/i.test(context.url),
    ...(context.turnCount !== undefined ? { turnCount: context.turnCount } : {}),
    ...(context.assistantTurnCount !== undefined ? { assistantTurnCount: context.assistantTurnCount } : {}),
    selectorTurnOffCount: candidates.filter(candidate => candidate.source === "selector" && candidate.kind === "turn-off").length,
    selectorTurnOnCount: candidates.filter(candidate => candidate.source === "selector" && candidate.kind === "turn-on").length,
    evaluateCandidatesCount: candidates.filter(candidate => candidate.source === "evaluate").length,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reason !== undefined ? { reason } : {})
  };
}

export async function ensureTemporaryChatOn(env: RuntimeEnv): Promise<CommandResult<TemporaryChatData>> {
  let before = await readTemporaryChatState(env);
  for (let attempt = 0; before.ok && before.data?.state === "unknown" && before.data.candidates.length === 0 && attempt < 3; attempt += 1) {
    await env.page?.waitForTimeout?.(750);
    before = await readTemporaryChatState(env);
  }
  if (!before.ok || before.data === undefined) {
    return before;
  }
  if (before.data.state === "on" && before.data.confidence === "verified") {
    return before;
  }
  if (before.data.state === "on") {
    return temporaryBlocker(env.page, "Temporary Chat state is inferred from URL but not verified on.", before.data);
  }
  if (before.data.state === "unknown") {
    return temporaryBlocker(env.page, "Temporary Chat state could not be verified before toggling.", before.data);
  }

  const clicked = await clickTemporaryCandidate(env.page!);
  if (!clicked) {
    return temporaryBlocker(env.page, "Temporary Chat toggle was not uniquely clickable.", before.data);
  }
  await env.page!.waitForTimeout?.(500);

  const after = await readTemporaryChatState(env);
  if (after.ok && after.data?.state === "on" && after.data.confidence === "verified") {
    return after;
  }
  return temporaryBlocker(env.page, "Temporary Chat did not become verified_on after toggling.", after.data);
}

export async function assertTemporaryChatVerifiedOn(env: RuntimeEnv): Promise<CommandResult<TemporaryChatData>> {
  const state = await readTemporaryChatState(env);
  if (state.ok && state.data?.state === "on" && state.data.confidence === "verified") {
    return state;
  }
  return temporaryBlocker(env.page, "Temporary Chat is not verified_on.", state.data);
}

async function ensurePage(env: RuntimeEnv): Promise<CommandResult<unknown>> {
  if (env.page !== undefined) {
    return resultOk({}, await contextFromPage(env.page));
  }
  return bootstrap(env, { preferExistingTab: true });
}

async function readTemporaryCandidates(page: PageLike): Promise<TemporaryCandidate[]> {
  const selectorCandidates = await readTemporaryCandidatesBySelectors(page);
  if (selectorCandidates.length > 0) {
    return selectorCandidates;
  }

  if (typeof page.evaluate !== "function") {
    return [];
  }

  return withTimeout(page.evaluate(() => {
    const labels = [/temporary chat/i, /一時チャット/];
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const matchesTemporary = (value: string) => labels.some(pattern => pattern.test(value));
    const sourceEvidence = (label: string, source: string) => ({ label, source });

    return Array.from(document.querySelectorAll("button, [role='button'], [role='switch'], [role='checkbox'], input[type='checkbox']"))
      .map(node => {
        const element = node as HTMLElement;
        const label = normalize(
          element.getAttribute("aria-label")
          || element.innerText
          || element.textContent
          || element.getAttribute("title")
        );
        if (!matchesTemporary(label)) return undefined;

        const onEvidence = [];
        const offEvidence = [];
        const ariaPressed = element.getAttribute("aria-pressed");
        const ariaChecked = element.getAttribute("aria-checked");
        const dataState = element.getAttribute("data-state");
        const className = typeof element.className === "string" ? element.className : "";
        const labelMeansTurnOn = /\bturn on\b/i.test(label) || /オンにする/.test(label);
        const labelMeansTurnOff = /\bturn off\b/i.test(label) || /オフにする/.test(label);
        const currentUrl = typeof document.location?.href === "string" ? document.location.href : "";
        const temporaryUrlOn = /[?&]temporary-chat=true\b/i.test(currentUrl);

        if (labelMeansTurnOff) onEvidence.push(sourceEvidence(label, "label-action=turn-off"));
        if (temporaryUrlOn) onEvidence.push(sourceEvidence(label, "url-param=temporary-chat=true"));
        if (ariaPressed === "true") onEvidence.push(sourceEvidence(label, "aria-pressed=true"));
        if (ariaChecked === "true") onEvidence.push(sourceEvidence(label, "aria-checked=true"));
        if (/^(checked|on|active|selected)$/i.test(dataState ?? "")) onEvidence.push(sourceEvidence(label, `data-state=${dataState}`));
        if (/\b(active|selected|checked)\b/i.test(className)) onEvidence.push(sourceEvidence(label, "selected-class"));
        if ((element as HTMLInputElement).checked === true) onEvidence.push(sourceEvidence(label, "input.checked=true"));
        if (document.body.innerText.match(/temporary chat (is )?(on|enabled)/i)) onEvidence.push(sourceEvidence(label, "page-temporary-on-text"));
        if (document.body.innerText.match(/一時チャット.*(オン|有効)/)) onEvidence.push(sourceEvidence(label, "page-temporary-on-text"));

        if (labelMeansTurnOn) offEvidence.push(sourceEvidence(label, "label-action=turn-on"));
        if (ariaPressed === "false") offEvidence.push(sourceEvidence(label, "aria-pressed=false"));
        if (ariaChecked === "false") offEvidence.push(sourceEvidence(label, "aria-checked=false"));
        if (/^(unchecked|off|inactive)$/i.test(dataState ?? "")) offEvidence.push(sourceEvidence(label, `data-state=${dataState}`));
        if ((element as HTMLInputElement).checked === false && element.tagName.toLowerCase() === "input") {
          offEvidence.push(sourceEvidence(label, "input.checked=false"));
        }

        const kind = labelMeansTurnOff ? "turn-off" : labelMeansTurnOn ? "turn-on" : "unknown";
        return { label, onEvidence, offEvidence, source: "evaluate", kind };
      })
      .filter((value): value is TemporaryCandidate => value !== undefined);
  }), 3000, "Timed out reading Temporary Chat state.").catch(() => []);
}

async function readTemporaryPageTextEvidence(page: PageLike): Promise<TemporaryChatEvidence | undefined> {
  if (typeof page.evaluate !== "function") {
    return undefined;
  }

  return withTimeout(page.evaluate(() => {
    const textPatterns = [
      /won['’]?t appear in history/i,
      /will not appear in history/i,
      /won['’]?t be saved/i,
      /will not be saved/i,
      /履歴に残ら/,
      /履歴には表示され/,
      /保存されません/
    ];
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const selectors = "h1, h2, h3, p, [role='heading'], [data-testid]";
    for (const element of Array.from(document.querySelectorAll(selectors)).slice(0, 60)) {
      const htmlElement = element as HTMLElement;
      const text = normalize(htmlElement.textContent);
      const testId = normalize(htmlElement.getAttribute("data-testid"));
      const matchedText = [text, testId].find(value => value.length > 0 && textPatterns.some(pattern => pattern.test(value)));
      if (matchedText !== undefined) {
        return { label: "Temporary Chat page text", source: "page-temporary-text" };
      }
    }
    return undefined;
  }), 1200, "Timed out reading lightweight Temporary Chat text.").catch(() => undefined);
}

async function clickTemporaryCandidate(page: PageLike): Promise<boolean> {
  const clickedBySelector = await clickTemporaryCandidateBySelector(page);
  if (clickedBySelector) {
    return true;
  }

  if (typeof page.evaluate === "function") {
    const clicked = await withTimeout(page.evaluate(() => {
      const labels = [/temporary chat/i, /一時チャット/];
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const matchesTemporary = (value: string) => labels.some(pattern => pattern.test(value));
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], [role='switch'], [role='checkbox'], input[type='checkbox']"))
        .filter(node => {
          const element = node as HTMLElement;
          const label = normalize(
            element.getAttribute("aria-label")
            || element.innerText
            || element.textContent
            || element.getAttribute("title")
          );
          return matchesTemporary(label);
        });
      if (candidates.length !== 1) return false;
      (candidates[0] as HTMLElement).click();
      return true;
    }), 3000, "Timed out clicking Temporary Chat candidate.").catch(() => false);
    if (clicked) return true;
  }

  return false;
}

async function readTemporaryCandidatesBySelectors(page: PageLike): Promise<TemporaryCandidate[]> {
  if (typeof page.locator !== "function") {
    return [];
  }

  const url = typeof page.url === "function"
    ? await withTimeout(Promise.resolve(page.url()), 3000, "Timed out reading page URL.").catch(() => "")
    : "";
  const temporaryUrlOn = /[?&]temporary-chat=true\b/i.test(url);
  const candidates: TemporaryCandidate[] = [];

  const turnOffLocator = page.locator(ariaButtonSelector(TEMPORARY_TURN_OFF_LABELS));
  if (await locatorCount(turnOffLocator) === 1) {
    const label = "Temporary Chat turn-off control";
    const onEvidence: TemporaryChatEvidence[] = [{ label, source: "label-action=turn-off" }];
    if (temporaryUrlOn) {
      onEvidence.push({ label, source: "url-param=temporary-chat=true" });
    }
    candidates.push({ label, onEvidence, offEvidence: [], source: "selector", kind: "turn-off" });
  }

  const turnOnLocator = page.locator(ariaButtonSelector(TEMPORARY_TURN_ON_LABELS));
  if (await locatorCount(turnOnLocator) === 1) {
    const label = "Temporary Chat turn-on control";
    candidates.push({
      label,
      onEvidence: [],
      offEvidence: [{ label, source: "label-action=turn-on" }],
      source: "selector",
      kind: "turn-on"
    });
  }

  return candidates;
}

async function clickTemporaryCandidateBySelector(page: PageLike): Promise<boolean> {
  if (typeof page.locator !== "function") {
    return false;
  }

  const locator = page.locator(ariaButtonSelector([...TEMPORARY_TURN_ON_LABELS, ...TEMPORARY_TURN_OFF_LABELS]));
  if (await locatorCount(locator) !== 1) {
    return false;
  }
  await withTimeout(locator.click?.({ timeoutMs: 5000 }) ?? Promise.resolve(), 6000, "Timed out clicking Temporary Chat button.");
  return true;
}

async function locatorCount(locator: { count?: () => Promise<number> } | undefined): Promise<number> {
  if (locator?.count === undefined) {
    return 0;
  }
  return withTimeout(locator.count(), 1000, "Timed out counting Temporary Chat candidates.").catch(() => 0);
}

function ariaButtonSelector(labels: string | string[]): string {
  const values = Array.isArray(labels) ? labels : [labels];
  return values.flatMap(label => [
    `button[aria-label="${cssAttributeValue(label)}"]`,
    `[role='button'][aria-label="${cssAttributeValue(label)}"]`
  ]).join(", ");
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function temporaryBlocker(
  page: PageLike | undefined,
  message: string,
  data: TemporaryChatData | undefined
): Promise<CommandResult<TemporaryChatData>> {
  const context = await contextFromPage(page);
  const assumedFromUrl = data?.state === "on" && data.confidence === "assumed_from_url";
  const temporaryDiagnostics = data?.diagnostics === undefined ? undefined : { ...data.diagnostics };
  if (temporaryDiagnostics !== undefined && (data?.candidates.length ?? 0) === 0) {
    const driftSnapshot = await readButtonDriftSnapshot(page);
    if (driftSnapshot.length > 0) {
      temporaryDiagnostics.driftSnapshot = driftSnapshot;
    }
  }

  const blocker: NonNullable<CommandResult["blocker"]> = {
    kind: assumedFromUrl ? "verification_policy" : "selector_drift",
    code: "temporary_chat_not_verified",
    message,
    resumable: true
  };
  const candidates = data?.candidates.map(label => ({ label }));
  if (candidates !== undefined) blocker.candidates = candidates;
  if (temporaryDiagnostics !== undefined) {
    blocker.diagnostics = { temporary: temporaryDiagnostics };
  }

  const result: CommandResult<TemporaryChatData> = {
    ok: false,
    status: "blocked",
    warnings: [],
    blocker,
    context
  };
  if (data !== undefined) result.data = data;
  return result;
}

async function readButtonDriftSnapshot(page: PageLike | undefined): Promise<TemporaryDriftSnapshotEntry[]> {
  if (typeof page?.evaluate !== "function") {
    return [];
  }

  return withTimeout(page.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("button, [role='button'], [role='switch'], [role='checkbox']"))
      .slice(0, 25)
      .map(node => {
        const element = node as HTMLElement;
        const entry: {
          ariaLabel?: string;
          dataTestId?: string;
          role?: string;
          title?: string;
          text?: string;
        } = {};
        const ariaLabel = normalize(element.getAttribute("aria-label"));
        const dataTestId = normalize(element.getAttribute("data-testid"));
        const role = normalize(element.getAttribute("role"));
        const title = normalize(element.getAttribute("title"));
        const text = normalize(element.innerText || element.textContent).slice(0, 80);
        if (ariaLabel.length > 0) entry.ariaLabel = ariaLabel;
        if (dataTestId.length > 0) entry.dataTestId = dataTestId;
        if (role.length > 0) entry.role = role;
        if (title.length > 0) entry.title = title;
        if (text.length > 0) entry.text = text;
        return entry;
      })
      .filter(entry => Object.keys(entry).length > 0);
  }), 1200, "Timed out reading Temporary Chat drift snapshot.").catch(() => []);
}
