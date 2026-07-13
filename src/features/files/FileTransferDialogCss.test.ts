import { describe, expect, it } from "vitest";

import css from "../../index.css?raw";

function ruleBody(selector: string) {
  const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("file transfer dialog styles", () => {
  it("uses an opaque surface so the terminal cannot show through", () => {
    const styles = ruleBody(".zt-file-transfer-dialog");

    expect(styles).toContain("background: var(--zt-bg-surface)");
    expect(styles).toContain("backdrop-filter: none");
    expect(styles).toContain("-webkit-backdrop-filter: none");
  });

  it("does not apply icon-button sizing to the conflict-policy select trigger", () => {
    expect(css).toContain(".zt-file-transfer-controls > button");
    expect(css).toContain(".zt-file-transfer-dialog .zt-file-transfer-controls > button");
    expect(css).not.toContain(".zt-file-transfer-dialog .zt-file-transfer-controls button,");
  });
});
