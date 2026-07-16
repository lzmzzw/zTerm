// Author: Liz
import { describe, expect, it } from "vitest";

import css from "../../index.css?raw";

function ruleBodiesForSelector(selector: string) {
  const bodies: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(css))) {
    const selectors = match[1].split(",").map((item) => item.trim());
    if (selectors.includes(selector)) {
      bodies.push(match[2]);
    }
  }

  return bodies;
}

describe("settings page css", () => {
  it("renders MCP tools as one list with identity on the left and description on the right", () => {
    const [toolListStyles] = ruleBodiesForSelector(".zt-mcp-tool-list");
    const [toolItemStyles, compactToolItemStyles] = ruleBodiesForSelector(".zt-mcp-tool-item");
    const descriptionStyles = ruleBodiesForSelector(".zt-mcp-tool-item p").join("\n");

    expect(toolListStyles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(toolItemStyles).toContain("display: grid");
    expect(toolItemStyles).toContain("grid-template-columns: minmax(220px, 0.9fr) minmax(0, 1.1fr)");
    expect(descriptionStyles).toContain("margin: 0");
    expect(compactToolItemStyles).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
