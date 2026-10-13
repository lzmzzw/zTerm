import { describe, expect, it } from "vitest";
import { ZmodemStartupObserver, ZmodemHexBodyObserver } from "./zmodemDiagnostics";

describe("restricted ZMODEM startup diagnostics", () => {
  const header = Uint8Array.from([42, 42, 24, 66, ...Array.from("0100000023be50", (c) => c.charCodeAt(0)), 13, 138, 17]);
  const encode = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
  it("preserves the startup header across every fragment boundary and omits terminal text", () => {
    for (let split = 0; split <= header.length; split++) {
      const observer = new ZmodemStartupObserver();
      const result = observer.consume(new TextEncoder().encode("password=ordinary-text\r\n"));
      result.push(...observer.consume(header.slice(0, split)));
      result.push(...observer.consume(header.slice(split)));
      result.push(...observer.consume(new TextEncoder().encode("ordinary tail")));
      expect(result).toEqual([encode(header.slice(0, 20))]);
    }
  });
  it("exposes a replacement-character terminator without recording subsequent text", () => {
    const observer = new ZmodemStartupObserver();
    const bytes = Uint8Array.from([...header.slice(0, 19), 239, 191, 189, ...new TextEncoder().encode("secret")]);
    expect(observer.consume(bytes)).toEqual([`${encode(bytes.slice(0, 22))} other`]);
  });
  it("finds stripped and intact prefixes across every fragment without logging terminal text", () => {
    for (const value of ["**B0100000023be50", "**\x18B0100000023be50"]) {
      const bytes = new TextEncoder().encode(value);
      for (let split = 0; split <= bytes.length; split++) {
        const observer = new ZmodemHexBodyObserver();
        expect(observer.consume(new TextEncoder().encode("ordinary-private-text."))).toEqual([]);
        const result = [...observer.consume(bytes.slice(0, split)), ...observer.consume(bytes.slice(split))];
        expect(result).toHaveLength(1);
        expect(result[0]).toContain(encode(new TextEncoder().encode("B0100000023be50")));
        expect(result[0]).not.toContain("private");
        expect(observer.consume(new TextEncoder().encode("ordinary tail"))).toEqual([]);
      }
    }
  });
});
