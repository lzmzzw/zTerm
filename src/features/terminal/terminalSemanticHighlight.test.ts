// Author: Liz
import { describe, expect, it } from "vitest";

import {
  findTerminalSemanticHighlights,
  type TerminalSemanticHighlight,
} from "./terminalSemanticHighlight";

function highlightedText(line: string, highlights: TerminalSemanticHighlight[]) {
  return highlights.map(({ start, end, role }) => ({ role, text: line.slice(start, end) }));
}

describe("findTerminalSemanticHighlights", () => {
  it("colors Unix permissions, metadata numbers, and dates like WindTerm's Linux lexer", () => {
    const line = "drwxr-x---  5 root root  4096 Jun 30 10:25 .cache/";

    expect(highlightedText(line, findTerminalSemanticHighlights(line))).toEqual([
      { role: "permissionType", text: "d" },
      { role: "permissionRead", text: "r" },
      { role: "permissionWrite", text: "w" },
      { role: "permissionExecute", text: "x" },
      { role: "permissionRead", text: "r" },
      { role: "permissionNone", text: "-" },
      { role: "permissionExecute", text: "x" },
      { role: "permissionNone", text: "-" },
      { role: "permissionNone", text: "-" },
      { role: "permissionNone", text: "-" },
      { role: "number", text: "5" },
      { role: "number", text: "4096" },
      { role: "date", text: "Jun 30 10:25" },
    ]);
  });

  it("keeps compound values intact instead of recoloring their internal numbers", () => {
    const line = "Login from 61.183.115.203 at 2026-07-14 15:33:12 via https://host.example/v1";

    expect(highlightedText(line, findTerminalSemanticHighlights(line))).toEqual([
      { role: "info", text: "Login" },
      { role: "ip", text: "61.183.115.203" },
      { role: "date", text: "2026-07-14" },
      { role: "date", text: "15:33:12" },
      { role: "url", text: "https://host.example/v1" },
    ]);
  });

  it("colors Linux status keywords while avoiding numbers embedded in file names", () => {
    const line = "success warning failed file-2026.log build42 98%";

    expect(highlightedText(line, findTerminalSemanticHighlights(line))).toEqual([
      { role: "success", text: "success" },
      { role: "warning", text: "warning" },
      { role: "error", text: "failed" },
      { role: "number", text: "98%" },
    ]);
  });

  it("does not mistake prose containing permission letters for an ls permission field", () => {
    const line = "draw write execute rwxr-x---x";

    expect(findTerminalSemanticHighlights(line)).toEqual([]);
  });

  it("highlights a CMD prompt, command, option, and directory listing metadata", () => {
    const prompt = "C:\\work\\zTerm>dir /a";
    const listing = "07/14/2026  02:33 PM    <DIR>          logs";

    expect(highlightedText(prompt, findTerminalSemanticHighlights(prompt))).toEqual([
      { role: "path", text: "C:\\work\\zTerm" },
      { role: "prompt", text: ">" },
      { role: "command", text: "dir" },
      { role: "option", text: "/a" },
    ]);
    expect(highlightedText(listing, findTerminalSemanticHighlights(listing))).toEqual([
      { role: "date", text: "07/14/2026" },
      { role: "date", text: "02:33 PM" },
      { role: "info", text: "<DIR>" },
    ]);
  });

  it("highlights PowerShell prompts and Get-ChildItem mode attributes", () => {
    const prompt = "PS C:\\work> Get-ChildItem -Force";
    const listing = "d-rh--        7/14/2026   2:33 PM                cache";

    expect(highlightedText(prompt, findTerminalSemanticHighlights(prompt))).toEqual([
      { role: "path", text: "C:\\work" },
      { role: "prompt", text: ">" },
      { role: "command", text: "Get-ChildItem" },
      { role: "option", text: "-Force" },
    ]);
    expect(highlightedText(listing, findTerminalSemanticHighlights(listing))).toEqual([
      { role: "attributeWarning", text: "d" },
      { role: "permissionNone", text: "-" },
      { role: "attributeError", text: "r" },
      { role: "attributeError", text: "h" },
      { role: "permissionNone", text: "-" },
      { role: "permissionNone", text: "-" },
      { role: "date", text: "7/14/2026" },
      { role: "date", text: "2:33 PM" },
    ]);
  });
});
