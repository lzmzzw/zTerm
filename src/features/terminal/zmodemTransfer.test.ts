// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMock = vi.hoisted(() => {
  const state = {
    instances: [] as Array<{
      options: any;
      consume: ReturnType<typeof vi.fn>;
    }>,
    consumeImpl: undefined as undefined | ((options: any, octets: number[] | Uint8Array) => void),
    Sentry: vi.fn(function (this: unknown, options: any) {
      const instance = {
        options,
        consume: vi.fn((octets: number[] | Uint8Array) => {
          if (state.consumeImpl) {
            state.consumeImpl(options, octets);
            return;
          }
          options.to_terminal(octets);
        }),
      };
      state.instances.push(instance);
      return instance;
    }),
  };
  return state;
});

vi.mock("zmodem.js/src/zmodem_browser", () => ({
  default: {
    DEBUG: false,
    Sentry: sentryMock.Sentry,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import {
  clearTerminalZmodemControllersForTest,
  consumeTerminalZmodemData,
} from "./zmodemTransfer";

describe("zmodemTransfer", () => {
  beforeEach(() => {
    sentryMock.instances.length = 0;
    sentryMock.consumeImpl = undefined;
    sentryMock.Sentry.mockClear();
    clearTerminalZmodemControllersForTest();
  });

  it("passes ordinary terminal bytes through the sentry terminal output path", () => {
    const appendOutput = vi.fn();

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "hello", dataBase64: base64([104, 101, 108, 108, 111]) },
      { appendOutput },
    );

    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "hello");
  });

  it("falls back to text output when raw bytes are absent", () => {
    const appendOutput = vi.fn();

    consumeTerminalZmodemData({ runtimeSessionId: "runtime-1", data: "plain" }, { appendOutput });

    expect(sentryMock.Sentry).not.toHaveBeenCalled();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "plain");
  });

  it("feeds coalesced lrzsz startup headers to the sentry one complete header at a time", () => {
    const appendOutput = vi.fn();
    const bytes = binaryBytes("rz waiting to receive.**\x18B0100000023be50\r\n**\x18B0100000023be50\r\n");

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(bytes) },
      { appendOutput },
    );

    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(2);
    expect(Array.from(sentryMock.instances[0].consume.mock.calls[0][0])).toEqual(
      binaryBytes("rz waiting to receive.**\x18B0100000023be50\r\n"),
    );
    expect(Array.from(sentryMock.instances[0].consume.mock.calls[1][0])).toEqual(
      binaryBytes("**\x18B0100000023be50\r\n"),
    );
  });

  it("logs parser failures without changing non-Error message text", () => {
    const appendOutput = vi.fn();
    sentryMock.consumeImpl = () => {
      throw "raw parser failure";
    };

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "fallback text", dataBase64: base64([42, 42, 66]) },
      { appendOutput },
    );

    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "fallback text");
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      expect.stringContaining("传输解析失败：raw parser failure"),
    );
  });

  it("stops feeding duplicate startup headers once the sentry confirms a transfer", async () => {
    const appendOutput = vi.fn();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };
    sentryMock.consumeImpl = (options) => {
      options.on_detect(detection);
    };

    consumeTerminalZmodemData(
      {
        runtimeSessionId: "runtime-1",
        data: "",
        dataBase64: base64(binaryBytes("rz waiting to receive.**\x18B0100000023be50\r\n**\x18B0100000023be50\r\n")),
      },
      {
        appendOutput,
        selectUploadFiles: vi.fn().mockResolvedValue([]),
      },
    );
    await flushPromises();

    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(1);
    expect(detection.confirm).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("未选择文件"));
  });

  it("uploads selected local files through a send session", async () => {
    sentryMock.consumeImpl = () => undefined;
    const appendOutput = vi.fn();
    const transfer = {
      get_offset: vi.fn(() => 0),
      send: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      type: "send",
      send_offer: vi.fn().mockResolvedValue(transfer),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "**B", dataBase64: base64([42, 42, 66]) },
      {
        appendOutput,
        selectUploadFiles: vi.fn().mockResolvedValue(["C:\\temp\\hello.txt"]),
        readLocalFiles: vi.fn().mockResolvedValue([
          { name: "hello.txt", size: 3, mtime_ms: 0, data: [1, 2, 3] },
        ]),
      },
    );
    sentryMock.instances[0].options.on_detect(detection);
    await flushPromises();

    expect(detection.confirm).toHaveBeenCalled();
    expect(session.send_offer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hello.txt",
        size: 3,
        files_remaining: 1,
        bytes_remaining: 3,
      }),
    );
    expect(Array.from(transfer.send.mock.calls[0][0])).toEqual([1, 2, 3]);
    expect(transfer.end).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(session.close).toHaveBeenCalled();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("上传完成"));
  });

  it("downloads offered remote files into the selected directory", async () => {
    sentryMock.consumeImpl = () => undefined;
    const appendOutput = vi.fn();
    let offerHandler: ((offer: any) => void) | null = null;
    let sessionEndHandler: (() => void) | null = null;
    const offer = {
      get_details: vi.fn(() => ({ name: "remote.txt", size: 3 })),
      accept: vi.fn().mockResolvedValue([new Uint8Array([4, 5]), [6]]),
    };
    const session: any = {
      type: "receive",
      on: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
        if (eventName === "offer") {
          offerHandler = handler;
        }
        if (eventName === "session_end") {
          sessionEndHandler = handler;
        }
        return session;
      }),
      start: vi.fn(() => {
        offerHandler?.(offer);
        sessionEndHandler?.();
      }),
      close: vi.fn(),
      abort: vi.fn(),
      send_offer: vi.fn(),
    };
    const saveFile = vi.fn().mockResolvedValue({ path: "D:\\Downloads\\remote.txt", bytes: 3 });
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "**B", dataBase64: base64([42, 42, 66]) },
      {
        appendOutput,
        selectDownloadDirectory: vi.fn().mockResolvedValue("D:\\Downloads"),
        saveFile,
      },
    );
    sentryMock.instances[0].options.on_detect(detection);
    await flushPromises();

    expect(session.start).toHaveBeenCalled();
    expect(offer.accept).toHaveBeenCalledWith({ on_input: "spool_uint8array" });
    expect(saveFile).toHaveBeenCalledWith("D:\\Downloads", "remote.txt", [4, 5, 6]);
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("下载完成，共 1 个文件"));
  });
});

function base64(bytes: number[]) {
  return window.btoa(String.fromCharCode(...bytes));
}

function binaryBytes(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0));
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}
