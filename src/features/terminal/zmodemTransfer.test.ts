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

const tauriClientMock = vi.hoisted(() => ({
  invokeTauri: vi.fn(),
}));

const dialogMock = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("zmodem.js/src/zmodem_browser", () => ({
  default: {
    DEBUG: false,
    Sentry: sentryMock.Sentry,
  },
}));

vi.mock("../../lib/tauriClient", () => ({
  invokeTauri: tauriClientMock.invokeTauri,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMock.open,
}));

import {
  clearTerminalZmodemControllersForTest,
  consumeTerminalZmodemData,
  releaseTerminalZmodemRuntime,
  ZMODEM_SINGLE_FILE_LIMIT_BYTES,
} from "./zmodemTransfer";

describe("zmodemTransfer", () => {
  beforeEach(() => {
    sentryMock.instances.length = 0;
    sentryMock.consumeImpl = undefined;
    sentryMock.Sentry.mockClear();
    tauriClientMock.invokeTauri.mockReset();
    dialogMock.open.mockReset();
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

  it("discards undecodable raw terminal bytes and reports a controlled error", () => {
    const appendOutput = vi.fn();

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "plain fallback", dataBase64: "not-base64" },
      { appendOutput },
    );

    expect(sentryMock.Sentry).not.toHaveBeenCalled();
    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", "plain fallback");
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("ZMODEM 原始输出解码失败"));
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

  it("does not replay raw control bytes when protocol parsing fails", () => {
    const appendOutput = vi.fn();
    sentryMock.consumeImpl = () => {
      throw "raw parser failure";
    };

    consumeTerminalZmodemData(
      {
        runtimeSessionId: "runtime-1",
        data: "\x1b[?2004h\x00ZMODEM binary tail",
        dataBase64: base64([42, 42, 66]),
      },
      { appendOutput },
    );

    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", "\x1b[?2004h\x00ZMODEM binary tail");
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      expect.stringContaining("传输解析失败：raw parser failure"),
    );
  });

  it("filters duplicate startup headers but preserves trailing bytes after a confirmed transfer", async () => {
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
    let consumeCount = 0;
    sentryMock.consumeImpl = (options) => {
      if (consumeCount === 0) {
        options.on_detect(detection);
      }
      consumeCount += 1;
    };

    consumeTerminalZmodemData(
      {
        runtimeSessionId: "runtime-1",
        data: "",
        dataBase64: base64(binaryBytes("rz waiting to receive.**\x18B0100000023be50\r\n**\x18B0100000023be50\r\n").concat([1, 2, 3])),
      },
      {
        appendOutput,
        selectUploadFiles: vi.fn().mockResolvedValue([]),
      },
    );
    await flushPromises();

    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(2);
    expect(Array.from(sentryMock.instances[0].consume.mock.calls[1][0])).toEqual(
      [1, 2, 3],
    );
    expect(detection.confirm).toHaveBeenCalled();
    expect(detection.deny).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("未选择文件"));
  });

  it("filters repeated startup headers across events while the upload picker is open", async () => {
    const appendOutput = vi.fn();
    const selectedPaths = deferred<string[]>();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(binaryBytes("rz.**\x18B0100000023be50\r\n")) },
      { appendOutput, selectUploadFiles: vi.fn(() => selectedPaths.promise) },
    );
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(binaryBytes("**\x18B0100000023be50\r\n")) },
      { appendOutput },
    );

    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(1);
    selectedPaths.resolve([]);
    await flushPromises();
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("uses the dialog plugin upload selector when no dependency override is supplied", async () => {
    const appendOutput = vi.fn();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = { confirm: vi.fn(() => session), deny: vi.fn() };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);
    dialogMock.open.mockResolvedValue(null);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput },
    );
    await flushPromises();

    expect(dialogMock.open).toHaveBeenCalledWith({
      title: "选择要通过 rz 上传的文件",
      multiple: true,
      directory: false,
    });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("uses the dialog plugin download directory selector when no dependency override is supplied", async () => {
    const appendOutput = vi.fn();
    const session = {
      type: "receive",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = { confirm: vi.fn(() => session), deny: vi.fn() };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);
    dialogMock.open.mockResolvedValue(null);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput },
    );
    await flushPromises();

    expect(dialogMock.open).toHaveBeenCalledWith({
      title: "选择 sz 下载保存目录",
      multiple: false,
      directory: true,
    });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("confirms that a real zmodem session rejects a repeated startup header", async () => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const RealZmodem: any = importedZmodem;
    const detections: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const sentry = new RealZmodem.Sentry({
        to_terminal: vi.fn(),
        sender: vi.fn(),
        on_detect: (detection: any) => {
          detections.push(detection);
          detection.confirm();
        },
        on_retract: vi.fn(),
      });
      const header: number[] = Array.from(RealZmodem.Header.build("ZRQINIT").to_hex() as number[]);

      sentry.consume(binaryBytes("sz waiting to send.").concat(header));
      expect(() => sentry.consume(header)).toThrow(/Unhandled header: ZRQINIT/);
      expect(detections).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("filters a coalesced repeated ZRQINIT after the first frame opens the download selector", async () => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const directory = deferred<string | null>();
    const appendOutput = vi.fn();
    const session = {
      type: "receive",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = { confirm: vi.fn(() => session), deny: vi.fn() };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);
    const zrqinit: number[] = Array.from((importedZmodem as any).Header.build("ZRQINIT").to_hex() as number[]);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit.concat(zrqinit)) },
      { appendOutput, selectDownloadDirectory: vi.fn(() => directory.promise) },
    );

    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(1);
    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", expect.stringContaining("传输解析失败"));
    directory.resolve(null);
    await flushPromises();
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it("only completes a pending ZRQINIT after directory selection and preserves following binary bytes", async () => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const directory = deferred<string | null>();
    const appendOutput = vi.fn();
    const session = {
      type: "receive",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = { confirm: vi.fn(() => session), deny: vi.fn() };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);
    const zrqinit: number[] = Array.from((importedZmodem as any).Header.build("ZRQINIT").to_hex() as number[]);
    const binaryTail = [4, 0, ...zrqinit, 255, 7];

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit) },
      { appendOutput, selectDownloadDirectory: vi.fn(() => directory.promise) },
    );
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit.slice(0, 6)) },
      { appendOutput },
    );
    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(1);

    directory.resolve("D:\\Downloads");
    await flushPromises();
    consumeTerminalZmodemData(
      {
        runtimeSessionId: "runtime-1",
        data: "",
        dataBase64: base64(zrqinit.slice(6).concat(binaryTail)),
      },
      { appendOutput },
    );

    expect(session.start).toHaveBeenCalledOnce();
    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(2);
    expect(Array.from(sentryMock.instances[0].consume.mock.calls[1][0])).toEqual(binaryTail);
  });

  it("downloads a 64 KiB-plus sz transfer after fragmented and coalesced repeated ZRQINIT frames", async () => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const RealZmodem: any = importedZmodem;
    const directory = deferred<string | null>();
    const appendOutput = vi.fn();
    const payload = Array.from({ length: 65_537 }, (_, index) => index % 256);
    const saveFile = vi.fn().mockResolvedValue({ path: "D:\\Downloads\\remote.bin", bytes: payload.length });
    let remoteSentry: any;
    let remoteSession: any;
    const dependencies = {
      appendOutput,
      createSentry: (options: any) => new RealZmodem.Sentry(options),
      selectDownloadDirectory: vi.fn(() => directory.promise),
      saveFile,
      sendBytes: vi.fn(async (_runtimeSessionId: string, data: number[]) => {
        remoteSentry.consume(data);
      }),
    };
    remoteSentry = new RealZmodem.Sentry({
      to_terminal: vi.fn(),
      sender: (bytes: number[] | Uint8Array) => {
        consumeTerminalZmodemData(
          { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(Array.from(bytes)) },
          dependencies,
        );
      },
      on_detect: (detection: any) => {
        remoteSession = detection.confirm();
        void remoteSession
          .send_offer({
            name: "remote.bin",
            size: payload.length,
            mtime: new Date(0),
            files_remaining: 1,
            bytes_remaining: payload.length,
          })
          .then(async (transfer: any) => {
            transfer.send(Uint8Array.from(payload));
            await transfer.end(new Uint8Array());
            await remoteSession.close();
          });
      },
      on_retract: vi.fn(),
    });
    const zrqinit: number[] = Array.from(RealZmodem.Header.build("ZRQINIT").to_hex() as number[]);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit) },
      dependencies,
    );
    await waitFor(() => appendOutput.mock.calls.some(([, output]) => output.includes("正在选择保存目录")));
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit.slice(0, 7)) },
      dependencies,
    );
    consumeTerminalZmodemData(
      {
        runtimeSessionId: "runtime-1",
        data: "",
        dataBase64: base64(zrqinit.slice(7).concat(zrqinit, zrqinit.slice(0, 5))),
      },
      dependencies,
    );
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(zrqinit.slice(5)) },
      dependencies,
    );

    directory.resolve("D:\\Downloads");
    await waitFor(() => appendOutput.mock.calls.some(([, output]) => output === "下载完成，共 1 个文件。\r\n"));

    expect(remoteSession).toBeDefined();
    expect(saveFile).toHaveBeenCalledWith("D:\\Downloads", "remote.bin", payload);
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "prompt# ", dataBase64: base64(binaryBytes("prompt# ")) },
      dependencies,
    );
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "prompt# ");
    releaseTerminalZmodemRuntime("runtime-1");
  });

  it("aborts a cancelled download selection and restores ordinary terminal output", async () => {
    const directory = deferred<string | null>();
    const appendOutput = vi.fn();
    const session = {
      type: "receive",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = { confirm: vi.fn(() => session), deny: vi.fn() };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput, selectDownloadDirectory: vi.fn(() => directory.promise) },
    );
    directory.resolve(null);
    await flushPromises();
    sentryMock.consumeImpl = undefined;

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "prompt# ", dataBase64: base64(binaryBytes("prompt# ")) },
      { appendOutput },
    );

    expect(session.abort).toHaveBeenCalledOnce();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "未选择保存目录，下载已取消。\r\n");
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "prompt# ");
    expect(sentryMock.Sentry).toHaveBeenCalledTimes(2);
  });

  it.each([3, 573, 65_537])("completes a real sender-receiver upload including the ZRINIT and ZFIN close handshakes (%i bytes)", async (size) => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const RealZmodem: any = importedZmodem;
    const appendOutput = vi.fn();
    const receivedPayloads: number[][] = [];
    const payload = Array.from({ length: size }, (_, index) => index % 256);
    const receiver = new RealZmodem.Session.Receive();
    receiver.on("offer", (offer: any) => {
      void offer.accept({ on_input: "spool_uint8array" }).then((payloads: Uint8Array[]) => {
        receivedPayloads.push(...payloads.map((payload: Uint8Array) => Array.from(payload)));
      });
    });
    const dependencies = {
      appendOutput,
      createSentry: (options: any) => new RealZmodem.Sentry(options),
      selectUploadFiles: vi.fn().mockResolvedValue(["C:\\temp\\handshake.txt"]),
      readLocalFiles: vi.fn().mockResolvedValue([
        { name: "handshake.txt", size, mtime_ms: 0, data: payload },
      ]),
      sendBytes: vi.fn(async (_runtimeSessionId: string, data: number[]) => {
        receiver.consume(data);
      }),
    };
    receiver.set_sender((bytes: number[]) => {
      consumeTerminalZmodemData(
        { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(Array.from(bytes)) },
        dependencies,
      );
    });

    receiver.start();
    await waitFor(() => appendOutput.mock.calls.some(([, output]) => output === "上传完成。\r\n"));

    expect(receivedPayloads.flat()).toEqual(payload);
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "上传完成。\r\n");
    releaseTerminalZmodemRuntime("runtime-1");
  });

  it("aborts a real upload session after a ZSINIT ZACK keepalive when file selection is cancelled", async () => {
    const { default: importedZmodem } = await vi.importActual<typeof import("zmodem.js/src/zmodem_browser")>(
      "zmodem.js/src/zmodem_browser",
    );
    const RealZmodem: any = importedZmodem;
    const appendOutput = vi.fn();
    const selectedPaths = deferred<string[]>();
    let sentry: any;
    const receiver = new RealZmodem.Session.Receive();
    const dependencies = {
      appendOutput,
      createSentry: (options: any) => {
        sentry = new RealZmodem.Sentry(options);
        return sentry;
      },
      selectUploadFiles: vi.fn(() => selectedPaths.promise),
      sendBytes: vi.fn(async (_runtimeSessionId: string, data: number[]) => {
        receiver.consume(data);
      }),
    };
    receiver.set_sender((bytes: number[]) => {
      consumeTerminalZmodemData(
        { runtimeSessionId: "runtime-1", data: "", dataBase64: base64(Array.from(bytes)) },
        dependencies,
      );
    });

    receiver.start();
    await waitFor(() => Boolean(sentry?.get_confirmed_session()));
    const sendSession = sentry.get_confirmed_session();
    sendSession._next_header_handler = {
      ZACK: () => {
        sendSession._got_ZSINIT_ZACK = true;
      },
    };
    sendSession._send_ZSINIT();
    await waitFor(() => sendSession._last_header_name === "ZACK");

    selectedPaths.resolve([]);
    await waitFor(() => appendOutput.mock.calls.some(([, output]) => output === "未选择文件，上传已取消。\r\n"));
    await waitFor(() => dependencies.sendBytes.mock.calls.some(([, data]) => data.slice(0, 5).every((byte) => byte === 24)));

    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", expect.stringContaining("Can’t close"));
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "未选择文件，上传已取消。\r\n");
    releaseTerminalZmodemRuntime("runtime-1");
  });

  it("abandons a failed parser session and recreates a clean sentry for later terminal output", () => {
    const appendOutput = vi.fn();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn(),
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
      throw new Error("bad frame");
    };

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "broken", dataBase64: base64([42, 42, 66]) },
      { appendOutput, selectUploadFiles: vi.fn().mockResolvedValue([]) },
    );

    expect(session.abort).toHaveBeenCalledOnce();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("传输解析失败：bad frame"));

    sentryMock.consumeImpl = undefined;
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "shell prompt", dataBase64: base64(binaryBytes("shell prompt")) },
      { appendOutput },
    );

    expect(sentryMock.Sentry).toHaveBeenCalledTimes(2);
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "shell prompt");
  });

  it("disposes an active protocol session after invalid base64 and recovers with a clean sentry", async () => {
    const appendOutput = vi.fn();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput, selectUploadFiles: vi.fn(() => new Promise<string[]>(() => undefined)) },
    );
    await Promise.resolve();

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "\x1b[?2004h\x00corrupt", dataBase64: "not-base64" },
      { appendOutput },
    );

    expect(session.abort).toHaveBeenCalledOnce();
    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", "\x1b[?2004h\x00corrupt");
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("ZMODEM 原始输出解码失败"));

    sentryMock.consumeImpl = undefined;
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "shell prompt", dataBase64: base64(binaryBytes("shell prompt")) },
      { appendOutput },
    );

    expect(sentryMock.Sentry).toHaveBeenCalledTimes(2);
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "shell prompt");
  });

  it("serializes sentry outbound frames before writing them to the terminal", async () => {
    const appendOutput = vi.fn();
    const firstWrite = deferred<void>();
    const sendBytes = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput, sendBytes },
    );
    const sender = sentryMock.instances[0].options.sender;
    sender([1, 2]);
    sender([3, 4]);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendBytes).toHaveBeenCalledTimes(1);
    expect(sendBytes).toHaveBeenLastCalledWith("runtime-1", [1, 2]);

    firstWrite.resolve();
    await flushPromises();
    expect(sendBytes).toHaveBeenCalledTimes(2);
    expect(sendBytes).toHaveBeenLastCalledWith("runtime-1", [3, 4]);
  });

  it("aborts on an outbound write failure and resumes ordinary terminal output with a new sentry", async () => {
    const appendOutput = vi.fn();
    const session = {
      type: "send",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };
    const sendBytes = vi.fn().mockRejectedValue(new Error("write failed"));
    sentryMock.consumeImpl = (options) => options.on_detect(detection);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      {
        appendOutput,
        sendBytes,
        selectUploadFiles: vi.fn(() => new Promise<string[]>(() => undefined)),
      },
    );
    sentryMock.instances[0].options.sender([1]);
    await flushPromises();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("ZMODEM 向远端发送失败：write failed"));

    sentryMock.consumeImpl = undefined;
    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "ready", dataBase64: base64(binaryBytes("ready")) },
      { appendOutput },
    );

    expect(sentryMock.Sentry).toHaveBeenCalledTimes(2);
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", "ready");
  });

  it("aborts an active transfer when its runtime is released and ignores delayed transfer callbacks", async () => {
    const appendOutput = vi.fn();
    const directory = deferred<string | null>();
    const session = {
      type: "receive",
      send_offer: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };
    sentryMock.consumeImpl = (options) => options.on_detect(detection);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "", dataBase64: base64([42]) },
      { appendOutput, selectDownloadDirectory: vi.fn(() => directory.promise) },
    );
    releaseTerminalZmodemRuntime("runtime-1");
    directory.resolve("D:\\Downloads");
    await flushPromises();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.start).not.toHaveBeenCalled();
    expect(appendOutput).not.toHaveBeenCalledWith("runtime-1", expect.stringContaining("下载已取消"));
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
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "\x1b[2K\r上传 hello.txt [░░░░░░░░░░░░░░░░░░░░]   0% 0 B / 3 B",
    );
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "\x1b[2K\r上传 hello.txt [████████████████████] 100% 3 B / 3 B\r\n",
    );
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("上传完成"));
    expect(appendOutput.mock.calls.every(([, output]) => !output.includes("[ZMODEM]"))).toBe(true);
  });

  it("downloads offered remote files into the selected directory", async () => {
    sentryMock.consumeImpl = () => undefined;
    const appendOutput = vi.fn();
    let offerHandler: ((offer: any) => void) | null = null;
    let sessionEndHandler: (() => void) | null = null;
    let inputHandler: ((payload: number[] | Uint8Array) => void) | null = null;
    const offer = {
      get_details: vi.fn(() => ({ name: "remote.txt", size: 3 })),
      on: vi.fn((eventName: string, handler: (payload: number[] | Uint8Array) => void) => {
        if (eventName === "input") {
          inputHandler = handler;
        }
        return offer;
      }),
      accept: vi.fn(async () => {
        inputHandler?.([4, 5]);
        inputHandler?.(new Uint8Array([6]));
        return [new Uint8Array([4, 5]), [6]];
      }),
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
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "\x1b[2K\r下载 remote.txt [░░░░░░░░░░░░░░░░░░░░]   0% 0 B / 3 B",
    );
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "\x1b[2K\r下载 remote.txt [█████████████░░░░░░░]  66% 2 B / 3 B",
    );
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "\x1b[2K\r下载 remote.txt [████████████████████] 100% 3 B / 3 B\r\n",
    );
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      "已保存 remote.txt -> D:\\Downloads\\remote.txt\r\n",
    );
    expect(appendOutput).toHaveBeenCalledWith("runtime-1", expect.stringContaining("下载完成，共 1 个文件"));
    expect(appendOutput.mock.calls.every(([, output]) => !output.includes("[ZMODEM]"))).toBe(true);
  });

  it("accepts a file at the ZMODEM limit and skips a known oversized file before spooling", async () => {
    sentryMock.consumeImpl = () => undefined;
    const appendOutput = vi.fn();
    let offerHandler: ((offer: any) => void) | null = null;
    const boundaryOffer = {
      get_details: vi.fn(() => ({ name: "boundary.bin", size: ZMODEM_SINGLE_FILE_LIMIT_BYTES })),
      on: vi.fn().mockReturnThis(),
      accept: vi.fn().mockResolvedValue([]),
      skip: vi.fn(),
    };
    const oversizedOffer = {
      get_details: vi.fn(() => ({ name: "oversized.bin", size: ZMODEM_SINGLE_FILE_LIMIT_BYTES + 1 })),
      on: vi.fn().mockReturnThis(),
      accept: vi.fn(),
      skip: vi.fn(),
    };
    const session: any = {
      type: "receive",
      on: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
        if (eventName === "offer") offerHandler = handler;
        return session;
      }),
      start: vi.fn(() => {
        offerHandler?.(boundaryOffer);
        offerHandler?.(oversizedOffer);
      }),
      close: vi.fn(),
      abort: vi.fn(),
      send_offer: vi.fn(),
    };
    const detection = {
      confirm: vi.fn(() => session),
      deny: vi.fn(),
    };

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "**B", dataBase64: base64([42, 42, 66]) },
      {
        appendOutput,
        selectDownloadDirectory: vi.fn().mockResolvedValue("D:\\Downloads"),
      },
    );
    sentryMock.instances[0].options.on_detect(detection);
    await flushPromises();

    expect(boundaryOffer.accept).toHaveBeenCalledWith({ on_input: "spool_uint8array" });
    expect(boundaryOffer.skip).not.toHaveBeenCalled();
    expect(oversizedOffer.skip).toHaveBeenCalledOnce();
    expect(oversizedOffer.accept).not.toHaveBeenCalled();
    expect(oversizedOffer.on).not.toHaveBeenCalled();
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      expect.stringMatching(/oversized\.bin.*32 MiB.*SFTP/),
    );
  });

  it("stops unknown-size and under-reported downloads when actual input exceeds the limit", async () => {
    sentryMock.consumeImpl = () => undefined;
    const appendOutput = vi.fn();
    let offerHandler: ((offer: any) => void) | null = null;
    const createLateOversizedOffer = (name: string, inputSizes: number[], size?: number) => {
      let inputHandler: ((payload: { length: number }) => void) | null = null;
      const offer = {
        get_details: vi.fn(() => ({ name, size })),
        on: vi.fn((eventName: string, handler: (payload: { length: number }) => void) => {
          if (eventName === "input") inputHandler = handler;
          return offer;
        }),
        accept: vi.fn(async () => {
          for (const length of inputSizes) inputHandler?.({ length });
          return [new Uint8Array([1])];
        }),
        skip: vi.fn(),
      };
      return offer;
    };
    const unknownSizeOffer = createLateOversizedOffer(
      "unknown-size.bin",
      [ZMODEM_SINGLE_FILE_LIMIT_BYTES + 1],
    );
    const underReportedOffer = createLateOversizedOffer(
      "under-reported.bin",
      [ZMODEM_SINGLE_FILE_LIMIT_BYTES, 1],
      1,
    );
    const session: any = {
      type: "receive",
      on: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
        if (eventName === "offer") offerHandler = handler;
        return session;
      }),
      start: vi.fn(() => {
        offerHandler?.(unknownSizeOffer);
        offerHandler?.(underReportedOffer);
      }),
      close: vi.fn(),
      abort: vi.fn(),
      send_offer: vi.fn(),
    };
    const saveFile = vi.fn();
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

    expect(unknownSizeOffer.accept).toHaveBeenCalledWith({ on_input: "spool_uint8array" });
    expect(unknownSizeOffer.skip).toHaveBeenCalledOnce();
    expect(underReportedOffer.accept).toHaveBeenCalledWith({ on_input: "spool_uint8array" });
    expect(underReportedOffer.skip).toHaveBeenCalledOnce();
    expect(saveFile).not.toHaveBeenCalled();
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      expect.stringMatching(/unknown-size\.bin.*32 MiB.*SFTP/),
    );
    expect(appendOutput).toHaveBeenCalledWith(
      "runtime-1",
      expect.stringMatching(/under-reported\.bin.*32 MiB.*SFTP/),
    );
  });

  it("completes a receive session when terminal output follows ZFIN without OO", async () => {
    const appendOutput = vi.fn();
    const terminalBytes = binaryBytes("\x1b[?2004h\x1b]0;root@host: ~\x07root@host:~# ");
    const receiveHandler = await startMockReceiveSession(appendOutput);
    receiveHandler({ NAME: "ZFIN" });

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "terminal prompt", dataBase64: base64(terminalBytes) },
      { appendOutput },
    );

    expect(Array.from(sentryMock.instances[0].consume.mock.calls[1][0])).toEqual([
      79,
      79,
      ...terminalBytes,
    ]);
  });

  it("preserves a normal OO marker split across terminal data events", async () => {
    const appendOutput = vi.fn();
    const receiveHandler = await startMockReceiveSession(appendOutput);
    receiveHandler({ NAME: "ZFIN" });

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "O", dataBase64: base64([79]) },
      { appendOutput },
    );
    expect(sentryMock.instances[0].consume).toHaveBeenCalledTimes(1);

    consumeTerminalZmodemData(
      { runtimeSessionId: "runtime-1", data: "O prompt", dataBase64: base64([79, 32, 35, 32]) },
      { appendOutput },
    );
    expect(Array.from(sentryMock.instances[0].consume.mock.calls[1][0])).toEqual([79, 79, 32, 35, 32]);
  });
});

function base64(bytes: number[]) {
  return window.btoa(String.fromCharCode(...bytes));
}

function binaryBytes(value: string) {
  return Array.from(value, (character) => character.charCodeAt(0));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await flushPromises();
  }
  throw new Error("Timed out waiting for ZMODEM local peer handshake");
}

async function startMockReceiveSession(appendOutput: (runtimeSessionId: string, data: string) => void) {
  sentryMock.consumeImpl = () => undefined;
  const receiveHandler = vi.fn();
  const session: any = {
    type: "receive",
    on: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
      if (eventName === "receive") {
        receiveHandler.mockImplementation(handler);
      }
      return session;
    }),
    start: vi.fn(),
    close: vi.fn(),
    abort: vi.fn(),
    send_offer: vi.fn(),
  };
  const detection = {
    confirm: vi.fn(() => session),
    deny: vi.fn(),
  };

  consumeTerminalZmodemData(
    { runtimeSessionId: "runtime-1", data: "**B", dataBase64: base64([42, 42, 66]) },
    {
      appendOutput,
      selectDownloadDirectory: vi.fn().mockResolvedValue("D:\\Downloads"),
    },
  );
  sentryMock.instances[0].options.on_detect(detection);
  await flushPromises();
  return receiveHandler;
}
