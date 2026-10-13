// Author: Liz
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Zmodem from "zmodem.js/src/zmodem_browser";

const local = vi.hoisted(() => ({ invokeTauri: vi.fn(), open: vi.fn() }));
vi.mock("../../lib/tauriClient", () => ({ invokeTauri: local.invokeTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: local.open }));

import { clearTerminalZmodemControllersForTest, consumeTerminalZmodemData } from "./zmodemTransfer";

// Both protocol endpoints and the production controller are real. Only the
// native IPC/file-dialog boundary is replaced by an in-memory binary transport.
const protocol: any = Zmodem;
const payload = Array.from({ length: 65_537 }, (_, index) => index % 256);
type Delivery = "fragmented" | "coalesced";
type OutputMock = ReturnType<typeof vi.fn<(runtimeSessionId: string, data: string) => void>>;

function wire(appendOutput: OutputMock, delivery: Delivery) {
  let first = true;
  return (octets: number[]) => {
    let bytes = Array.from(octets);
    if (first && delivery === "coalesced") {
      // lrzsz can emit its banner and repeated startup header in one read.
      bytes = [...Array.from("waiting to receive.", (c) => c.charCodeAt(0)), ...bytes, ...bytes];
    }
    const fragmentSizes = first ? [1, 2, 3, 5, 7, 2] : [257, 4096, 8191];
    first = false;
    const feed = (chunk: number[]) => consumeTerminalZmodemData({
      runtimeSessionId: "protocol-runtime",
      data: "",
      dataBase64: btoa(String.fromCharCode(...chunk)),
    }, { appendOutput });
    if (delivery === "coalesced") {
      feed(bytes);
    } else {
      for (let offset = 0, index = 0; offset < bytes.length; index += 1) {
        const length = fragmentSizes[index % fragmentSizes.length];
        feed(bytes.slice(offset, offset + length));
        offset += length;
      }
    }
  };
}

function setupNativeBoundary(remoteConsume: (bytes: number[]) => void, saved: number[][] = []) {
  local.invokeTauri.mockImplementation(async (command: string, args: any) => {
    switch (command) {
      case "terminal_zmodem_diagnostic": return;
      case "terminal_write_bytes": remoteConsume(Array.from(args.data)); return;
      case "terminal_zmodem_read_files":
        expect(args.paths).toEqual(["C:\\test\\all-bytes.bin"]);
        return [{ name: "all-bytes.bin", size: payload.length, mtime_ms: 0, data: payload }];
      case "terminal_zmodem_save_file":
        expect(args.directory).toBe("C:\\test\\downloads");
        expect(args.fileName).toBe("all-bytes.bin");
        saved.push(Array.from(args.data));
        return { path: "C:\\test\\downloads\\all-bytes.bin", bytes: args.data.length };
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
}

function outputHas(output: OutputMock, text: string) {
  return output.mock.calls.some(([, value]) => value === text);
}

describe("real ZMODEM protocol through terminal raw-byte IPC", () => {
  beforeEach(() => {
    local.invokeTauri.mockReset();
    local.open.mockReset();
    clearTerminalZmodemControllersForTest();
  });
  afterEach(() => clearTerminalZmodemControllersForTest());

  it.each<Delivery>(["fragmented", "coalesced"])("uploads all 256 byte values using rz with %s startup", async (delivery) => {
    const output = vi.fn<(runtimeSessionId: string, data: string) => void>();
    const received: number[][] = [];
    const receiver = new protocol.Session.Receive();
    receiver.on("offer", (offer: any) => {
      expect(offer.get_details().name).toBe("all-bytes.bin");
      void offer.accept({ on_input: "spool_uint8array" }).then((chunks: Uint8Array[]) => {
        received.push(chunks.flatMap((chunk) => Array.from(chunk)));
      });
    });
    setupNativeBoundary((bytes) => receiver.consume(bytes));
    local.open.mockResolvedValue(["C:\\test\\all-bytes.bin"]);
    receiver.set_sender(wire(output, delivery));
    receiver.start();
    await vi.waitFor(() => expect(outputHas(output, "上传完成。\r\n")).toBe(true));
    expect(received).toEqual([payload]);
    expect(local.open).toHaveBeenCalledOnce();
    expect(output.mock.calls.some(([, text]) => text.includes("传输失败") || text.includes("解析失败"))).toBe(false);
  });

  it.each<Delivery>(["fragmented", "coalesced"])("downloads all 256 byte values using sz with %s startup", async (delivery) => {
    const output = vi.fn<(runtimeSessionId: string, data: string) => void>();
    const saved: number[][] = [];
    const sendToFrontend = wire(output, delivery);
    let sending: Promise<void> | undefined;
    const remote = new protocol.Sentry({
      to_terminal: () => undefined,
      sender: sendToFrontend,
      on_retract: () => undefined,
      on_detect: (detection: any) => {
        const sender = detection.confirm();
        sending = (async () => {
          const transfer = await sender.send_offer({ name: "all-bytes.bin", size: payload.length, mtime: new Date(0) });
          expect(transfer).toBeDefined();
          await transfer.end(payload);
          await sender.close();
        })();
      },
    });
    setupNativeBoundary((bytes) => remote.consume(bytes), saved);
    local.open.mockResolvedValue("C:\\test\\downloads");
    // Use the library's real bootstrap encoder, then its actual Send session.
    sendToFrontend(protocol.Header.build("ZRQINIT").to_hex());
    await vi.waitFor(() => expect(outputHas(output, "下载完成，共 1 个文件。\r\n")).toBe(true));
    await sending;
    expect(saved).toEqual([payload]);
    expect(local.open).toHaveBeenCalledOnce();
    expect(output.mock.calls.some(([, text]) => text.includes("传输失败") || text.includes("解析失败"))).toBe(false);
  });

  it("cancels the file picker and then completes the next real rz transfer on the same runtime", async () => {
    const output = vi.fn<(runtimeSessionId: string, data: string) => void>();
    let receiver = new protocol.Session.Receive();
    setupNativeBoundary((bytes) => receiver.consume(bytes));
    local.open.mockResolvedValueOnce(null).mockResolvedValue(["C:\\test\\all-bytes.bin"]);
    receiver.set_sender(wire(output, "fragmented"));
    receiver.start();
    await vi.waitFor(() => expect(outputHas(output, "未选择文件，上传已取消。\r\n")).toBe(true));
    await vi.waitFor(() => expect(receiver.aborted()).toBe(true));
    receiver = new protocol.Session.Receive();
    const received: number[][] = [];
    receiver.on("offer", (offer: any) => {
      void offer.accept({ on_input: "spool_uint8array" }).then((chunks: Uint8Array[]) => received.push(chunks.flatMap((chunk) => Array.from(chunk))));
    });
    receiver.set_sender(wire(output, "coalesced"));
    receiver.start();
    await vi.waitFor(() => expect(outputHas(output, "上传完成。\r\n")).toBe(true));
    expect(received).toEqual([payload]);
    expect(local.open).toHaveBeenCalledTimes(2);
  });
});
