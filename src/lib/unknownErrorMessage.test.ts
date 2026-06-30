// Author: Liz
import { describe, expect, it } from "vitest";

import { fallbackOnlyErrorMessage, stringifiedErrorMessage, unknownErrorMessage } from "./unknownErrorMessage";

describe("unknownErrorMessage", () => {
  it("keeps the default store error semantics", () => {
    expect(unknownErrorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(unknownErrorMessage("plain error", "fallback")).toBe("plain error");
    expect(unknownErrorMessage("", "fallback")).toBe("");
    expect(unknownErrorMessage({ code: "unknown" }, "fallback")).toBe("fallback");
  });

  it("supports panel-friendly blank string and object message fallbacks", () => {
    expect(unknownErrorMessage("", "fallback", { blankStringFallback: true })).toBe("fallback");
    expect(
      unknownErrorMessage(
        {
          code: "ai",
          message: "LLM 响应中未找到文本内容",
        },
        "fallback",
        { objectMessage: true },
      ),
    ).toBe("LLM 响应中未找到文本内容");
    expect(unknownErrorMessage({ message: " " }, "fallback", { objectMessage: true })).toBe("fallback");
  });

  it("can preserve fallback-only semantics for non-Error string throws", () => {
    expect(unknownErrorMessage("plain error", "fallback", { stringMessage: false })).toBe("fallback");
    expect(fallbackOnlyErrorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(fallbackOnlyErrorMessage("plain error", "fallback")).toBe("fallback");
    expect(fallbackOnlyErrorMessage({ code: "unknown" }, "fallback")).toBe("fallback");
  });

  it("can preserve String(error) fallback semantics for opaque throws", () => {
    expect(stringifiedErrorMessage(new Error("boom"))).toBe("boom");
    expect(stringifiedErrorMessage("plain error")).toBe("plain error");
    expect(stringifiedErrorMessage({ code: "unknown" })).toBe("[object Object]");
    expect(stringifiedErrorMessage(null)).toBe("null");
  });
});
