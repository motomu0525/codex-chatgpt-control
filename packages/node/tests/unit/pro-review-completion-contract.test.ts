import { describe, expect, it } from "vitest";
import { validateProReviewCompletionContract } from "../../src/pro-review/completion-contract.js";

describe("Pro review completion contract", () => {
  it("accepts a final completion marker with a matching receipt", () => {
    const result = validateProReviewCompletionContract([
      "結論",
      "",
      "PRO_REVIEW_RECEIPT_V1",
      "packId: pack-123",
      "packNonce: nonce-456",
      "manifestSha256: abc",
      "coverageStatus: COMPLETE",
      "PRO_REVIEW_COMPLETE"
    ].join("\n"), {
      receipt: {
        packId: "pack-123",
        packNonce: "nonce-456",
        manifestSha256: "abc",
        coverageStatus: "COMPLETE"
      }
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a completion marker that is not the final non-empty line", () => {
    const result = validateProReviewCompletionContract([
      "PRO_REVIEW_COMPLETE",
      "追記"
    ].join("\n"));

    expect(result).toMatchObject({
      ok: false,
      code: "completion_marker_not_final"
    });
  });

  it("rejects an explicitly incomplete review", () => {
    const result = validateProReviewCompletionContract("PRO_REVIEW_INCOMPLETE");

    expect(result).toMatchObject({
      ok: false,
      code: "incomplete_declared"
    });
  });

  it("rejects an incomplete marker even when a complete marker follows", () => {
    const result = validateProReviewCompletionContract([
      "Partial review.",
      "PRO_REVIEW_INCOMPLETE",
      "PRO_REVIEW_COMPLETE"
    ].join("\n"));

    expect(result).toMatchObject({
      ok: false,
      code: "incomplete_declared"
    });
  });

  it("rejects mismatched receipt fields", () => {
    const result = validateProReviewCompletionContract([
      "PRO_REVIEW_RECEIPT_V1",
      "packNonce: actual",
      "PRO_REVIEW_COMPLETE"
    ].join("\n"), {
      receipt: {
        packNonce: "expected"
      }
    });

    expect(result).toMatchObject({
      ok: false,
      code: "receipt_field_mismatch"
    });
  });
});
