// 解析独立 ConPTY 合成探针，无用户终端数据。
import fs from "node:fs";
import assert from "node:assert/strict";
import xterm from "@xterm/xterm";

// 参数顺序：Standard 捕获、FullScreen 捕获；省略第二个参数时仅检查汇总。
const summaries = [];
for (const path of process.argv.slice(2)) {
  const capture = JSON.parse(fs.readFileSync(path, "utf8"));
  const terminal = new xterm.Terminal({ allowProposedApi: true, cols: capture.cols, rows: capture.rows, scrollback: 1000 });
  await new Promise((resolve) => terminal.write(capture.data, resolve));
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "");
  assert.ok(lines.some(line => line.trimEnd() === "AFTER-024"), "捕获必须覆盖最后一个固定输出标记");
  const history = lines.slice(0, buffer.baseY);
  const expectedHistory = Array.from({ length: 31 }, (_, index) => `HISTORY-${String(index).padStart(3, "0")}`);
  const missingHistory = expectedHistory.filter(value => !lines.some(line => line.trimEnd() === value));
  const summary = { path, historyRows: buffer.baseY, blankHistoryRows: history.filter(line => !line.trim()).length, missingHistory, workingHistoryRows: history.filter(line => /Working/.test(line)), resultCount: lines.filter(line => /RESULT-/.test(line)).length };
  summaries.push(summary);
  console.log(JSON.stringify(summary, null, 2));
  terminal.dispose();
}
if (summaries.length === 2) {
  assert.deepEqual(summaries[0].missingHistory, ["HISTORY-028", "HISTORY-029"]);
  assert.deepEqual(summaries[1].missingHistory, []);
  for (const summary of summaries) {
    assert.equal(summary.resultCount, 12);
    assert.deepEqual(summary.workingHistoryRows, []);
  }
  console.log("PASS: Standard grow_viewport 丢失两条历史，FullScreen 保留；两组均未复现 Working 残片。");
}
