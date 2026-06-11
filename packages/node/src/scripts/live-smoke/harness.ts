import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactReportValue } from "../../safety/report-redaction.js";
import type {
  LiveSmokeBrowser,
  LiveSmokeCleanupResult,
  LiveSmokeContext,
  LiveSmokeRunResult,
  LiveSmokeScenario,
  LiveSmokeScenarioResult
} from "./types.js";

const CLEANUP_TIMEOUT_MS = 10_000;

export function envFlag(name: string): boolean {
  const value = readEnv(name);
  return value === "1" || value?.toLowerCase() === "true";
}

export function envText(name: string): string | undefined {
  const value = readEnv(name)?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function contextEnvFlag(context: LiveSmokeContext, name: string): boolean {
  const value = contextEnvText(context, name);
  return value === "1" || value?.toLowerCase() === "true";
}

export function contextEnvText(context: LiveSmokeContext, name: string): string | undefined {
  const value = context.env?.[name]?.trim() ?? envText(name);
  return value && value.length > 0 ? value : undefined;
}

function readEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}

export async function runScenario(
  scenario: LiveSmokeScenario,
  context: LiveSmokeContext
): Promise<LiveSmokeScenarioResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  let result: LiveSmokeScenarioResult;
  if (!scenario.enabled(context)) {
    result = {
      name: scenario.name,
      status: "skip",
      required: scenario.required,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      details: { reason: "scenario disabled" }
    };
  } else {
    try {
      result = await scenario.run(context);
    } catch (error) {
      result = {
        name: scenario.name,
        status: "fail",
        required: scenario.required,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  const cleanup = await finalizeBrowserTabs(context.browser);
  return { ...result, cleanup };
}

export async function runLiveSmoke(
  context: LiveSmokeContext,
  scenarios: LiveSmokeScenario[]
): Promise<LiveSmokeRunResult> {
  const results: LiveSmokeScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, context);
    results.push(result);
    console.log(JSON.stringify(redactLiveSmokeResult(result), null, 2));
  }

  const reportPath = await writeReport(context.reportDir, results);
  const failures = requiredFailures(results);
  console.log(JSON.stringify({ reportPath, requiredFailures: failures.map(failure => failure.name) }, null, 2));
  return { reportPath, results, requiredFailures: failures };
}

export async function writeReport(reportDir: string, results: LiveSmokeScenarioResult[]): Promise<string> {
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const path = join(reportDir, `${stamp}-live-smoke.json`);
  const summary = {
    total: results.length,
    passed: results.filter(result => result.status === "pass").length,
    failed: results.filter(result => result.status === "fail").length,
    skipped: results.filter(result => result.status === "skip").length,
    requiredFailures: requiredFailures(results).map(result => result.name)
  };
  await writeFile(path, `${JSON.stringify({ summary, results: results.map(redactLiveSmokeResult) }, null, 2)}\n`, "utf8");
  return path;
}

export function redactLiveSmokeResult(result: LiveSmokeScenarioResult): LiveSmokeScenarioResult {
  const redacted = redactReportValue(result, { includeContent: false }) as LiveSmokeScenarioResult;
  return {
    ...redacted,
    name: result.name,
    status: result.status,
    required: result.required,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs
  };
}

export function requiredFailures(results: LiveSmokeScenarioResult[]): LiveSmokeScenarioResult[] {
  return results.filter(result => result.required && result.status !== "pass");
}

export function filterScenarios(
  scenarios: LiveSmokeScenario[],
  namesCsv: string | undefined
): LiveSmokeScenario[] {
  if (namesCsv === undefined || namesCsv.trim().length === 0) {
    return scenarios;
  }

  const wanted = new Set(
    namesCsv.split(",")
      .map(name => name.trim())
      .filter(Boolean)
  );
  return scenarios.filter(scenario => wanted.has(scenario.name));
}

async function finalizeBrowserTabs(browser: LiveSmokeBrowser | undefined): Promise<LiveSmokeCleanupResult> {
  const tabs = browser?.tabs;
  const finalize = tabs?.finalize;
  if (typeof finalize !== "function") {
    return {
      attempted: false,
      ok: false,
      reason: "browser.tabs.finalize unavailable"
    };
  }

  try {
    await withTimeout(
      finalize.call(tabs, { keep: [] }),
      CLEANUP_TIMEOUT_MS,
      `browser.tabs.finalize timed out after ${CLEANUP_TIMEOUT_MS}ms`
    );
    return { attempted: true, ok: true };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observedPromise = Promise.resolve(promise);
  observedPromise.catch(() => {});
  try {
    return await Promise.race([
      observedPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
