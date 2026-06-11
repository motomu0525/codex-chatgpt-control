import { describe, expect, it } from "vitest";
import { withTimeout as browserWithTimeout } from "../../src/browser/evaluate.js";
import { withTimeout as commandWithTimeout } from "../../src/commands/timeouts.js";

describe("timeout helpers", () => {
  it("observes late command rejections after the deadline", async () => {
    const events: unknown[] = [];
    const listener = (reason: unknown): void => {
      events.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const lateReject = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late command rejection")), 20);
      });
      await expect(commandWithTimeout(lateReject, 1, "deadline")).rejects.toThrow("deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("observes late browser evaluation rejections after the deadline", async () => {
    const events: unknown[] = [];
    const listener = (reason: unknown): void => {
      events.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const lateReject = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late browser rejection")), 20);
      });
      await expect(browserWithTimeout(lateReject, 1, "deadline")).rejects.toThrow("deadline");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
