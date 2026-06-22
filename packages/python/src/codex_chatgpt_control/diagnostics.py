from __future__ import annotations

from typing import Any

from .models import CommandResult


BLOCKER_PROFILES: dict[str, dict[str, Any]] = {
    "browser_bridge_unavailable": {
        "title": "Browser bridge unavailable",
        "category": "environment",
        "severity": "blocked",
        "userActionRequired": False,
        "retryReason": "Retry only after changing the execution environment or bootstrapping the Codex Chrome bridge.",
    },
    "login_required": {
        "title": "Login required",
        "category": "auth",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry after the user signs in to ChatGPT; do not auto-submit a prompt.",
    },
    "captcha": {
        "title": "Captcha or human verification required",
        "category": "auth",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry after the user completes the visible verification; do not auto-submit a prompt.",
    },
    "rate_limit": {
        "title": "Rate limited",
        "category": "auth",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry only after the usage window resets or the user selects a different safe path.",
    },
    "modal": {
        "title": "Modal is blocking the page",
        "category": "runtime",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry after the blocking modal is dismissed or handled.",
    },
    "permission": {
        "title": "Permission required",
        "category": "permission",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry after the reported permission setting changes and only if the command is safe to resume.",
    },
    "confirmation": {
        "title": "Confirmation required",
        "category": "user_confirmation",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry only after the user approves the exact bounded action.",
    },
    "verification_policy": {
        "title": "Verification policy",
        "category": "runtime",
        "severity": "blocked",
        "userActionRequired": False,
        "retryReason": "Do not retry blindly; inspect the verification diagnostics and retry only after verified UI evidence is available.",
    },
    "selector_drift": {
        "title": "Selector drift",
        "category": "ui_drift",
        "severity": "blocked",
        "userActionRequired": False,
        "retryReason": "Do not retry blindly; update selectors/localization or move the visible UI to a supported state.",
    },
    "artifact_unavailable": {
        "title": "Artifact unavailable",
        "category": "artifact",
        "severity": "warning",
        "userActionRequired": False,
        "retryReason": "Retry only after the artifact appears or the command can safely re-check without resubmitting a prompt.",
    },
    "artifact_selector_drift": {
        "title": "Artifact selector drift",
        "category": "ui_drift",
        "severity": "blocked",
        "userActionRequired": False,
        "retryReason": "Do not retry blindly; update artifact selectors before resuming.",
    },
    "artifact_download_unavailable": {
        "title": "Artifact download unavailable",
        "category": "download",
        "severity": "warning",
        "userActionRequired": False,
        "retryReason": "Retry only after a download control appears, or use a safe visible asset fallback if the caller requested it.",
    },
    "download_unavailable": {
        "title": "Download unavailable",
        "category": "download",
        "severity": "warning",
        "userActionRequired": False,
        "retryReason": "Retry only after a downloadable affordance appears; do not resubmit the prompt just to create one.",
    },
    "upload_failed": {
        "title": "Upload failed",
        "category": "upload",
        "severity": "action_required",
        "userActionRequired": True,
        "retryReason": "Retry after the upload blocker is fixed and only if the prompt has not already been submitted.",
    },
    "not_found": {
        "title": "Target not found",
        "category": "not_found",
        "severity": "warning",
        "userActionRequired": False,
        "retryReason": "Retry only after the target changes or the caller relaxes the targeting policy.",
    },
    "unknown": {
        "title": "Unknown blocker",
        "category": "unknown",
        "severity": "blocked",
        "userActionRequired": False,
        "retryReason": "Inspect the structured blocker and retry only after the cause is understood.",
    },
}

NEVER_AUTO_RESUME = {
    "captcha",
    "login_required",
    "rate_limit",
    "verification_policy",
    "selector_drift",
    "artifact_selector_drift",
    "unknown",
}


def explain_blocker(
    result_or_blocker: CommandResult | dict[str, Any] | None,
    *,
    command: str | None = None,
    context: dict[str, Any] | None = None,
    state_id: str | None = None,
    next_commands: list[str] | None = None,
) -> dict[str, Any]:
    result = result_or_blocker if isinstance(result_or_blocker, CommandResult) else None
    blocker = result.blocker if result is not None else result_or_blocker
    if not isinstance(blocker, dict):
        explanation = {
            "kind": "none",
            "title": "No blocker",
            "summary": "The command result does not include a browser-control blocker.",
            "severity": "info",
            "category": "unknown",
            "userActionRequired": False,
            "retry": {"safe": False, "reason": "There is no blocker-specific retry guidance."},
            "resume": {"supported": False, "reason": "This result has no resumable browser-control blocker."},
            "remediation": [],
            "nextCommands": next_commands or [],
        }
        merged_context = _explanation_context(result.context if result is not None else context, command)
        if merged_context:
            explanation["context"] = merged_context
        explanation["markdown"] = _render_markdown(explanation)
        return explanation

    kind = str(blocker.get("kind", "unknown"))
    profile = BLOCKER_PROFILES.get(kind, BLOCKER_PROFILES["unknown"])
    remediation = list(blocker.get("remediation") or [])
    resume = _resume_guidance(blocker, command=command, state_id=state_id)
    retry = _retry_guidance(blocker, profile, resume, command=command)
    summary = _summary(blocker)
    explanation = {
        "kind": kind,
        "title": profile["title"],
        "summary": summary,
        "severity": profile["severity"],
        "category": _category(blocker, profile),
        "userActionRequired": bool(profile["userActionRequired"] or any(step.get("userActionRequired") for step in remediation if isinstance(step, dict))),
        "retry": retry,
        "resume": resume,
        "remediation": remediation,
        "nextCommands": next_commands if next_commands is not None else _default_next_commands(blocker, command),
    }
    if "code" in blocker:
        explanation["code"] = blocker["code"]
    merged_context = _explanation_context(result.context if result is not None else context, command)
    if merged_context:
        explanation["context"] = merged_context
    if isinstance(blocker.get("candidates"), list):
        explanation["candidates"] = blocker["candidates"]
    if isinstance(blocker.get("diagnostics"), dict):
        explanation["diagnostics"] = blocker["diagnostics"]
    explanation["markdown"] = _render_markdown(explanation)
    return explanation


def _summary(blocker: dict[str, Any]) -> str:
    kind = str(blocker.get("kind", "unknown"))
    code = blocker.get("code")
    code_text = f" ({code})" if isinstance(code, str) and code else ""
    return f"{kind}{code_text}: {blocker.get('message', kind)}"


def _category(blocker: dict[str, Any], profile: dict[str, Any]) -> str:
    if blocker.get("kind") == "not_found" and str(blocker.get("code", "")).startswith("existing_tab_"):
        return "targeting"
    return str(profile["category"])


def _resume_guidance(blocker: dict[str, Any], *, command: str | None, state_id: str | None) -> dict[str, Any]:
    kind = str(blocker.get("kind", "unknown"))
    if kind in NEVER_AUTO_RESUME:
        return {"supported": False, "reason": "This blocker is not safe to resume automatically."}
    if blocker.get("resumable") is True or (blocker.get("resumable") is None and kind in {"confirmation", "permission"}):
        resume: dict[str, Any] = {"supported": True}
        if state_id is not None:
            resume["stateId"] = state_id
        if command is not None:
            resume["command"] = command
        return resume
    return {"supported": False, "reason": "The underlying browser-control command did not mark this blocker as resumable."}


def _retry_guidance(blocker: dict[str, Any], profile: dict[str, Any], resume: dict[str, Any], *, command: str | None) -> dict[str, Any]:
    if resume.get("supported") is True:
        retry: dict[str, Any] = {"safe": True, "when": _retry_when(blocker)}
        if command is not None:
            retry["command"] = command
        return retry
    return {"safe": False, "reason": profile["retryReason"]}


def _retry_when(blocker: dict[str, Any]) -> str:
    kind = blocker.get("kind")
    if kind in {"permission", "upload_failed"}:
        return "After the reported permission/upload issue is fixed and before any duplicate prompt submission."
    if kind == "confirmation":
        return "After the user approves the exact bounded action."
    if kind in {"download_unavailable", "artifact_download_unavailable"}:
        return "After the download affordance appears without resubmitting the prompt."
    return "After the blocker is resolved and the command remains safe to resume."


def _default_next_commands(blocker: dict[str, Any], command: str | None) -> list[str]:
    kind = blocker.get("kind")
    code = str(blocker.get("code", ""))
    if kind == "browser_bridge_unavailable":
        return ["session.bootstrap"]
    if kind == "not_found" and code.startswith("existing_tab_") and command is not None:
        return [command]
    if command is not None and _resume_guidance(blocker, command=command, state_id=None).get("supported") is True:
        return [command]
    return []


def _explanation_context(source: dict[str, Any] | None, command: str | None) -> dict[str, Any]:
    context: dict[str, Any] = {}
    if command is not None:
        context["command"] = command
    if source is None:
        return context
    for key in ("url", "conversationId", "tabId"):
        value = source.get(key)
        if value is not None:
            context[key] = value
    return context


def _render_markdown(explanation: dict[str, Any]) -> str:
    lines = [
        f"### {explanation['title']}",
        "",
        str(explanation["summary"]),
        "",
        f"- Kind: `{explanation['kind']}`",
    ]
    if "code" in explanation:
        lines.append(f"- Code: `{explanation['code']}`")
    lines.append(f"- Category: `{explanation['category']}`")
    lines.append(f"- Severity: `{explanation['severity']}`")
    context = explanation.get("context")
    if isinstance(context, dict):
        if context.get("command") is not None:
            lines.append(f"- Command: `{context['command']}`")
        if context.get("url") is not None:
            lines.append(f"- URL: {context['url']}")
        if context.get("conversationId") is not None:
            lines.append(f"- Conversation: `{context['conversationId']}`")
        if context.get("tabId") is not None:
            lines.append(f"- Tab: `{context['tabId']}`")

    lines.append("")
    retry = explanation["retry"]
    if retry.get("safe") is True:
        lines.append(f"Retry: safe only {retry['when']}")
    else:
        lines.append(f"Retry: {retry['reason']}")

    resume = explanation["resume"]
    if resume.get("supported") is True:
        state = f" with state `{resume['stateId']}`" if resume.get("stateId") is not None else ""
        lines.append(f"Resume: supported{state}.")
    else:
        lines.append(f"Resume: {resume['reason']}")

    remediation = explanation.get("remediation")
    if isinstance(remediation, list) and remediation:
        lines.extend(["", "Remediation:"])
        for step in remediation:
            if isinstance(step, dict):
                lines.append(f"- {step.get('label', 'Step')}: {step.get('instruction', '')}")

    candidates = explanation.get("candidates")
    if isinstance(candidates, list) and candidates:
        lines.extend(["", "Candidates:"])
        for candidate in candidates:
            if isinstance(candidate, dict):
                role = f" ({candidate['role']})" if candidate.get("role") is not None else ""
                lines.append(f"- {candidate.get('label', '')}{role}")

    existing_tab = (explanation.get("diagnostics") or {}).get("existingTab") if isinstance(explanation.get("diagnostics"), dict) else None
    if isinstance(existing_tab, dict):
        lines.extend(["", "Existing-tab diagnostics:"])
        target = existing_tab.get("requestedTarget") or {}
        lines.append(f"- Target: `{target.get('type', 'unknown')}`")
        lines.append(f"- Mismatch: `{existing_tab.get('mismatchReason', 'unknown')}`")
        lines.append(f"- User-open tab enumeration: `{'available' if existing_tab.get('userOpenTabsAvailable') else 'unavailable'}`")
        lines.append(f"- ChatGPT tabs seen: `{existing_tab.get('chatgptTabCount', 0)}`")
        for tab in existing_tab.get("candidateTabs") or []:
            if isinstance(tab, dict):
                lines.append(f"- Candidate tab {tab.get('id', 'unknown')}: {tab.get('title', 'Untitled')} - {tab.get('url', 'unknown URL')}")

    return "\n".join(lines)
