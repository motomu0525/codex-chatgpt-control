import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createChatGPT } from "../../src/client.js";
import { BROWSER_BRIDGE_REMEDIATION } from "../../src/errors.js";
import { explainCommandBlocker } from "../../src/diagnostics/blockers.js";
import type { BlockerKind, CommandResult } from "../../src/types.js";

const context = {
  timestamp: "2026-06-09T00:00:00.000Z",
  command: "session.bootstrap",
  url: "https://chatgpt.com/c/abc-123",
  conversationId: "abc-123",
  tabId: "tab-1"
};

const blockerKinds: BlockerKind[] = [
  "browser_bridge_unavailable",
  "login_required",
  "captcha",
  "rate_limit",
  "modal",
  "permission",
  "confirmation",
  "verification_policy",
  "selector_drift",
  "artifact_unavailable",
  "artifact_selector_drift",
  "artifact_download_unavailable",
  "download_unavailable",
  "upload_failed",
  "not_found",
  "unknown"
];

const profileFixture = JSON.parse(readFileSync(
  new URL("../../contracts/v1/fixtures/blocker-explanation-profiles.json", import.meta.url),
  "utf8"
)) as {
  result: {
    profiles: Array<{
      kind: string;
      title: string;
      category: string;
      severity: string;
      userActionRequired: boolean;
    }>;
  };
};

describe("blocker explanations", () => {
  it("explains every blocker kind with structured guidance and markdown", () => {
    for (const kind of blockerKinds) {
      const explanation = explainCommandBlocker({
        kind,
        message: `Blocked by ${kind}.`
      }, { command: "messages.ask", context });

      expect(explanation.kind).toBe(kind);
      expect(explanation.title).not.toHaveLength(0);
      expect(explanation.summary).toContain(kind);
      expect(explanation.category).not.toHaveLength(0);
      expect(explanation.retry).toBeDefined();
      expect(explanation.resume.supported).toBe(kind === "permission" || kind === "confirmation");
      if (kind === "selector_drift" || kind === "artifact_selector_drift") {
        expect(explanation.nextCommands).toEqual([]);
      }
      expect(explanation.markdown).toContain(explanation.title);
      expect(explanation.markdown).toContain(kind);
    }
  });

  it("matches the shared blocker explanation profile fixture", () => {
    for (const profile of profileFixture.result.profiles) {
      const explanation = explainCommandBlocker({
        kind: profile.kind as BlockerKind,
        message: `Blocked by ${profile.kind}.`
      }, { command: "messages.ask" });

      expect(explanation).toMatchObject({
        kind: profile.kind,
        title: profile.title,
        category: profile.category,
        severity: profile.severity,
        userActionRequired: profile.userActionRequired
      });
    }
  });

  it("falls back safely for forward-compatible unknown blocker kind strings", () => {
    const explanation = explainCommandBlocker({
      kind: "future_blocker_kind",
      message: "A future backend returned a new blocker."
    } as unknown as NonNullable<CommandResult["blocker"]>, { command: "messages.ask" });

    expect(explanation.kind).toBe("future_blocker_kind");
    expect(explanation.title).toBe("Unknown blocker");
    expect(explanation.category).toBe("unknown");
    expect(explanation.resume.supported).toBe(false);
    expect(explanation.markdown).toContain("future_blocker_kind");
  });

  it("accepts a CommandResult and exposes chatgpt.explainBlocker", () => {
    const result: CommandResult = {
      ok: false,
      status: "blocked",
      warnings: [],
      context,
      blocker: {
        kind: "login_required",
        message: "ChatGPT login is required before this command can continue."
      }
    };

    const chatgpt = createChatGPT();
    const direct = explainCommandBlocker(result, { command: "session.bootstrap" });
    const fromClient = chatgpt.explainBlocker(result, { command: "session.bootstrap" });

    expect(fromClient).toEqual(direct);
    expect(fromClient.userActionRequired).toBe(true);
    expect(fromClient.category).toBe("auth");
  });

  it("preserves permission remediation labels and resumable state", () => {
    const explanation = explainCommandBlocker({
      kind: "permission",
      code: "upload_permission_required",
      message: "Upload permission required.",
      remediation: [
        {
          label: "Codex Chrome uploads",
          instruction: "Codex Settings > Computer Use > Chrome > Permissions > Uploads: set to Always allow.",
          userActionRequired: true
        },
        {
          label: "Chrome file URLs",
          instruction: "Chrome chrome://extensions > Codex extension > Details: enable Allow access to file URLs.",
          userActionRequired: true
        }
      ],
      resumable: true
    }, { command: "files.attach", stateId: "interruption-1" });

    expect(explanation.remediation.map(step => step.label)).toEqual([
      "Codex Chrome uploads",
      "Chrome file URLs"
    ]);
    expect(explanation.resume).toEqual({
      supported: true,
      stateId: "interruption-1",
      command: "files.attach"
    });
    expect(explanation.retry.safe).toBe(true);
  });

  it("normalizes default permission and confirmation resumability in the public helper", () => {
    for (const kind of ["permission", "confirmation"] as const) {
      const explanation = explainCommandBlocker({
        kind,
        message: `${kind} needs attention.`
      }, { command: "messages.ask", stateId: "interruption-1" });

      expect(explanation.resume).toEqual({
        supported: true,
        stateId: "interruption-1",
        command: "messages.ask"
      });
      expect(explanation.nextCommands).toEqual(["messages.ask"]);
    }
  });

  it("preserves selector drift candidates and blocks blind resume", () => {
    const explanation = explainCommandBlocker({
      kind: "selector_drift",
      message: "Mode option was not found.",
      candidates: [
        { label: "Thinking", role: "menuitem" },
        { label: "Recherche approfondie", role: "menuitem" }
      ],
      resumable: true
    }, { command: "modes.set" });

    expect(explanation.category).toBe("ui_drift");
    expect(explanation.candidates).toEqual([
      { label: "Thinking", role: "menuitem" },
      { label: "Recherche approfondie", role: "menuitem" }
    ]);
    expect(explanation.resume.supported).toBe(false);
    expect(explanation.nextCommands).toEqual([]);
    expect(explanation.markdown).toContain("Recherche approfondie");
  });

  it("renders Temporary Chat verification diagnostics without chat content", () => {
    const explanation = explainCommandBlocker({
      kind: "verification_policy",
      code: "temporary_chat_not_verified",
      message: "Temporary Chat state is inferred from URL but not verified on.",
      diagnostics: {
        temporary: {
          urlTemporaryParam: true,
          turnCount: 0,
          assistantTurnCount: 0,
          selectorTurnOffCount: 0,
          selectorTurnOnCount: 0,
          evaluateCandidatesCount: 0,
          confidence: "assumed_from_url",
          reason: "url_empty_chat_without_dom_signal"
        }
      },
      resumable: true
    }, { command: "temporary.ensureOn" });

    expect(explanation.category).toBe("runtime");
    expect(explanation.resume.supported).toBe(false);
    expect(explanation.markdown).toContain("Temporary Chat diagnostics");
    expect(explanation.markdown).toContain("url_empty_chat_without_dom_signal");
  });

  it("keeps ordinary-shell and live-bootstrap bridge remediation distinct", () => {
    const explanation = explainCommandBlocker({
      kind: "browser_bridge_unavailable",
      code: "codex_chrome_bridge_unavailable",
      message: "Codex cannot access the ChatGPT browser bridge from this backend process.",
      remediation: BROWSER_BRIDGE_REMEDIATION
    }, { command: "session.bootstrap" });

    expect(explanation.category).toBe("environment");
    expect(explanation.remediation.map(step => step.label)).toEqual([
      "Ordinary shell",
      "Codex Chrome bootstrap",
      "Python live bridge",
      "Extension availability"
    ]);
    expect(explanation.markdown).toContain("Ordinary shell");
    expect(explanation.markdown).toContain("setupBrowserRuntime");
  });

  it("renders existing-tab diagnostics without page or chat content", () => {
    const explanation = explainCommandBlocker({
      kind: "not_found",
      code: "existing_tab_not_found",
      message: "No already-open ChatGPT tab matched the requested existing-tab target.",
      visibleText: "PRIVATE CHAT CONTENT SHOULD NOT RENDER",
      diagnostics: {
        existingTab: {
          requestedTarget: {
            type: "conversationId",
            conversationId: "abc-123"
          },
          userOpenTabsAvailable: true,
          chatgptTabCount: 1,
          mismatchReason: "conversation_id_mismatch",
          candidateTabs: [
            {
              id: "other",
              url: "https://chatgpt.com/c/other",
              title: "Other Chat",
              conversationId: "other"
            }
          ]
        }
      }
    }, { command: "session.bootstrap" });

    expect(explanation.category).toBe("targeting");
    expect(explanation.diagnostics?.existingTab?.candidateTabs[0]).toMatchObject({
      id: "other",
      url: "https://chatgpt.com/c/other",
      title: "Other Chat",
      conversationId: "other"
    });
    expect(explanation.markdown).toContain("Existing-tab diagnostics");
    expect(explanation.markdown).toContain("https://chatgpt.com/c/other");
    expect(explanation.markdown).not.toContain("PRIVATE CHAT CONTENT");
  });
});
