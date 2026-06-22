export const PRO_REVIEW_COMPLETE_MARKER = "PRO_REVIEW_COMPLETE";
export const PRO_REVIEW_INCOMPLETE_MARKER = "PRO_REVIEW_INCOMPLETE";
export const PRO_REVIEW_RECEIPT_MARKER = "PRO_REVIEW_RECEIPT_V1";

export type ProReviewCompletionContract = {
  completionMarker?: string;
  receipt?: {
    packId?: string;
    packNonce?: string;
    manifestSha256?: string;
    coverageStatus?: string;
  };
};

export type ProReviewCompletionValidation =
  | {
      ok: true;
      marker: string;
      receipt: Record<string, string>;
    }
  | {
      ok: false;
      code:
        | "answer_empty"
        | "completion_marker_missing"
        | "completion_marker_not_final"
        | "incomplete_declared"
        | "receipt_missing"
        | "receipt_field_missing"
        | "receipt_field_mismatch";
      message: string;
      marker?: string;
      receipt?: Record<string, string>;
    };

export function validateProReviewCompletionContract(
  answerText: string,
  contract: ProReviewCompletionContract = {}
): ProReviewCompletionValidation {
  const completionMarker = contract.completionMarker ?? PRO_REVIEW_COMPLETE_MARKER;
  const lines = answerText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) {
    return {
      ok: false,
      code: "answer_empty",
      message: "Pro review answer is empty."
    };
  }

  const finalLine = lines[lines.length - 1];
  if (lines.includes(PRO_REVIEW_INCOMPLETE_MARKER)) {
    return {
      ok: false,
      code: "incomplete_declared",
      message: "Pro review explicitly declared that the review is incomplete.",
      marker: PRO_REVIEW_INCOMPLETE_MARKER
    };
  }
  if (!lines.includes(completionMarker)) {
    return {
      ok: false,
      code: "completion_marker_missing",
      message: `Pro review answer does not contain required completion marker ${completionMarker}.`
    };
  }
  if (finalLine !== completionMarker) {
    return {
      ok: false,
      code: "completion_marker_not_final",
      message: `Completion marker ${completionMarker} must be the final non-empty line.`,
      marker: completionMarker
    };
  }

  const receipt = parseProReviewReceipt(lines);
  const expectedReceipt = contract.receipt ?? {};
  if (Object.keys(expectedReceipt).length > 0 && receipt === undefined) {
    return {
      ok: false,
      code: "receipt_missing",
      message: `Pro review answer is missing ${PRO_REVIEW_RECEIPT_MARKER}.`
    };
  }

  const parsedReceipt = receipt ?? {};
  for (const [field, expected] of Object.entries(expectedReceipt)) {
    if (expected === undefined) continue;
    const actual = parsedReceipt[field];
    if (actual === undefined) {
      return {
        ok: false,
        code: "receipt_field_missing",
        message: `Pro review receipt is missing ${field}.`,
        receipt: parsedReceipt
      };
    }
    if (actual !== expected) {
      return {
        ok: false,
        code: "receipt_field_mismatch",
        message: `Pro review receipt field ${field} did not match the expected value.`,
        receipt: parsedReceipt
      };
    }
  }

  return {
    ok: true,
    marker: completionMarker,
    receipt: parsedReceipt
  };
}

function parseProReviewReceipt(lines: string[]): Record<string, string> | undefined {
  const start = lines.lastIndexOf(PRO_REVIEW_RECEIPT_MARKER);
  if (start < 0) {
    return undefined;
  }

  const receipt: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line === PRO_REVIEW_COMPLETE_MARKER || line === PRO_REVIEW_INCOMPLETE_MARKER) break;
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      receipt[match[1]] = match[2];
    }
  }
  return receipt;
}
