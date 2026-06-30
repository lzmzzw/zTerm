// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Zmodem, {
  type ZmodemDetection,
  type ZmodemOffer,
  type ZmodemSentry,
  type ZmodemSentryOptions,
  type ZmodemSession,
  type ZmodemTransfer,
} from "zmodem.js/src/zmodem_browser";

import { stringifiedErrorMessage } from "../../lib/unknownErrorMessage";

interface TerminalZmodemDataEvent {
  runtimeSessionId: string;
  data: string;
  dataBase64?: string;
}

interface TerminalZmodemLocalFile {
  name: string;
  size: number;
  mtime_ms: number;
  data: number[];
}

interface TerminalZmodemSavedFile {
  path: string;
  bytes: number;
}

interface ZmodemTransferDependencies {
  appendOutput: (runtimeSessionId: string, data: string) => void;
  sendBytes?: (runtimeSessionId: string, data: number[]) => Promise<void>;
  selectUploadFiles?: () => Promise<string[]>;
  selectDownloadDirectory?: () => Promise<string | null>;
  readLocalFiles?: (paths: string[]) => Promise<TerminalZmodemLocalFile[]>;
  saveFile?: (directory: string, fileName: string, data: number[]) => Promise<TerminalZmodemSavedFile>;
  createSentry?: (options: ZmodemSentryOptions) => ZmodemSentry;
}

const controllers = new Map<string, ZmodemRuntimeController>();
const SEND_CHUNK_BYTES = 64 * 1024;
const ZMODEM_ASTERISK = 42;
const ZMODEM_ZDLE = 24;
const ZMODEM_HEADER_B = 66;
const ASCII_ZERO = 48;
const ASCII_ONE = 49;
const ASCII_LINE_FEED = 10;
const ASCII_HIGH_LINE_FEED = 0x8a;
const ASCII_XON = 0x11;
const MIN_ZMODEM_HEX_HEADER_LF_OFFSET = 18;
const MAX_ZMODEM_HEX_HEADER_LF_OFFSET = 19;

export function consumeTerminalZmodemData(
  event: TerminalZmodemDataEvent,
  dependencies: ZmodemTransferDependencies,
) {
  if (!event.dataBase64) {
    dependencies.appendOutput(event.runtimeSessionId, event.data);
    return;
  }

  const bytes = decodeBase64Bytes(event.dataBase64);
  if (!bytes.length) {
    return;
  }

  const controller = getController(event.runtimeSessionId, dependencies);
  controller.consume(bytes, event.data);
}

export function releaseTerminalZmodemRuntime(runtimeSessionId: string) {
  controllers.delete(runtimeSessionId);
}

export function clearTerminalZmodemControllersForTest() {
  controllers.clear();
}

function getController(runtimeSessionId: string, dependencies: ZmodemTransferDependencies) {
  const existing = controllers.get(runtimeSessionId);
  if (existing) {
    existing.updateDependencies(dependencies);
    return existing;
  }
  const controller = new ZmodemRuntimeController(runtimeSessionId, dependencies);
  controllers.set(runtimeSessionId, controller);
  return controller;
}

class ZmodemRuntimeController {
  private dependencies: ZmodemTransferDependencies;
  private readonly sentry: ZmodemSentry;
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: false });
  private activeSession: ZmodemSession | null = null;

  constructor(private readonly runtimeSessionId: string, dependencies: ZmodemTransferDependencies) {
    this.dependencies = withDefaultDependencies(dependencies);
    this.sentry = this.dependencies.createSentry?.({
      to_terminal: (octets) => this.appendOutput(this.octetsToText(octets)),
      sender: (octets) => {
        void this.dependencies.sendBytes?.(this.runtimeSessionId, Array.from(octets));
      },
      on_detect: (detection) => {
        void this.handleDetection(detection);
      },
      on_retract: () => {
        this.appendOutput("\r\n[ZMODEM] 已取消检测到的传输。\r\n");
      },
    }) ?? new Zmodem.Sentry({
      to_terminal: (octets) => this.appendOutput(this.octetsToText(octets)),
      sender: (octets) => {
        void this.dependencies.sendBytes?.(this.runtimeSessionId, Array.from(octets));
      },
      on_detect: (detection) => {
        void this.handleDetection(detection);
      },
      on_retract: () => {
        this.appendOutput("\r\n[ZMODEM] 已取消检测到的传输。\r\n");
      },
    });
  }

  updateDependencies(dependencies: ZmodemTransferDependencies) {
    this.dependencies = withDefaultDependencies(dependencies);
  }

  consume(bytes: Uint8Array, fallbackText: string) {
    try {
      const chunks = this.activeSession ? [bytes] : splitCoalescedZmodemStartupBytes(bytes);
      for (const chunk of chunks) {
        this.sentry.consume(Array.from(chunk));
        if (this.activeSession) {
          break;
        }
      }
    } catch (error) {
      this.appendOutput(fallbackText);
      this.appendOutput(`\r\n[ZMODEM] 传输解析失败：${stringifiedErrorMessage(error)}\r\n`);
      this.activeSession = null;
    }
  }

  private async handleDetection(detection: ZmodemDetection) {
    if (this.activeSession) {
      detection.deny();
      return;
    }

    const session = detection.confirm();
    this.activeSession = session;
    try {
      if (session.type === "send") {
        await this.runUpload(session);
      } else {
        await this.runDownload(session);
      }
    } catch (error) {
      session.abort?.();
      this.appendOutput(`\r\n[ZMODEM] 传输失败：${stringifiedErrorMessage(error)}\r\n`);
      this.activeSession = null;
    }
  }

  private async runUpload(session: ZmodemSession) {
    this.appendOutput("\r\n[ZMODEM] rz 请求上传文件，正在选择本机文件...\r\n");
    const paths = await this.dependencies.selectUploadFiles?.();
    if (!paths?.length) {
      await session.close();
      this.appendOutput("[ZMODEM] 未选择文件，上传已取消。\r\n");
      this.activeSession = null;
      return;
    }

    const files = await this.dependencies.readLocalFiles?.(paths);
    if (!files?.length) {
      await session.close();
      this.appendOutput("[ZMODEM] 未读取到可上传文件。\r\n");
      this.activeSession = null;
      return;
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let remainingBytes = totalBytes;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const transfer = await session.send_offer({
        name: file.name,
        size: file.size,
        mtime: new Date(file.mtime_ms),
        files_remaining: files.length - index,
        bytes_remaining: remainingBytes,
      });
      remainingBytes -= file.size;
      if (!transfer) {
        this.appendOutput(`[ZMODEM] 远端跳过 ${file.name}。\r\n`);
        continue;
      }
      await sendFileBytes(transfer, Uint8Array.from(file.data));
      this.appendOutput(`[ZMODEM] 已上传 ${file.name} (${file.size} bytes)。\r\n`);
    }

    await session.close();
    this.appendOutput("[ZMODEM] 上传完成。\r\n");
    this.activeSession = null;
  }

  private async runDownload(session: ZmodemSession) {
    this.appendOutput("\r\n[ZMODEM] sz 请求下载文件，正在选择保存目录...\r\n");
    const directory = await this.dependencies.selectDownloadDirectory?.();
    if (!directory) {
      session.abort?.();
      this.appendOutput("[ZMODEM] 未选择保存目录，下载已取消。\r\n");
      this.activeSession = null;
      return;
    }

    let savedCount = 0;
    const saveTasks: Array<Promise<void>> = [];
    session.on("offer", (offer: ZmodemOffer) => {
      const details = offer.get_details();
      const saveTask = offer
        .accept({ on_input: "spool_uint8array" })
        .then((payloads) => this.dependencies.saveFile?.(directory, details.name, flattenPayloads(payloads)))
        .then((saved) => {
          if (!saved) return;
          savedCount += 1;
          this.appendOutput(`[ZMODEM] 已下载 ${details.name} -> ${saved.path} (${saved.bytes} bytes)。\r\n`);
        })
        .catch((error) => {
          this.appendOutput(`[ZMODEM] 保存 ${details.name} 失败：${stringifiedErrorMessage(error)}\r\n`);
        });
      saveTasks.push(saveTask);
    });
    session.on("session_end", () => {
      void Promise.allSettled(saveTasks).then(() => {
        this.appendOutput(`[ZMODEM] 下载完成，共 ${savedCount} 个文件。\r\n`);
        this.activeSession = null;
      });
    });
    session.start();
  }

  private appendOutput(data: string) {
    if (!data) return;
    this.dependencies.appendOutput(this.runtimeSessionId, data);
  }

  private octetsToText(octets: number[] | Uint8Array) {
    return this.textDecoder.decode(octets instanceof Uint8Array ? octets : Uint8Array.from(octets), { stream: true });
  }
}

async function sendFileBytes(transfer: ZmodemTransfer, bytes: Uint8Array) {
  let offset = Math.max(0, transfer.get_offset());
  while (offset < bytes.length) {
    const nextOffset = Math.min(bytes.length, offset + SEND_CHUNK_BYTES);
    transfer.send(bytes.slice(offset, nextOffset));
    offset = nextOffset;
  }
  await transfer.end(new Uint8Array());
}

function flattenPayloads(payloads: Array<Uint8Array | number[]>) {
  const total = payloads.reduce((sum, payload) => sum + payload.length, 0);
  const data = new Array<number>(total);
  let offset = 0;
  for (const payload of payloads) {
    for (const byte of payload) {
      data[offset] = byte;
      offset += 1;
    }
  }
  return data;
}

function withDefaultDependencies(dependencies: ZmodemTransferDependencies): ZmodemTransferDependencies {
  return {
    ...dependencies,
    sendBytes:
      dependencies.sendBytes ??
      ((runtimeSessionId, data) => invoke("terminal_write_bytes", { runtimeSessionId, data })),
    selectUploadFiles: dependencies.selectUploadFiles ?? selectUploadFiles,
    selectDownloadDirectory: dependencies.selectDownloadDirectory ?? selectDownloadDirectory,
    readLocalFiles:
      dependencies.readLocalFiles ??
      ((paths) => invoke<TerminalZmodemLocalFile[]>("terminal_zmodem_read_files", { paths })),
    saveFile:
      dependencies.saveFile ??
      ((directory, fileName, data) =>
        invoke<TerminalZmodemSavedFile>("terminal_zmodem_save_file", { directory, fileName, data })),
  };
}

function splitCoalescedZmodemStartupBytes(bytes: Uint8Array) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const headerStart = findZmodemHexHeaderStart(bytes, offset);
    if (headerStart < 0) {
      chunks.push(bytes.slice(offset));
      break;
    }

    const headerEnd = findZmodemHexHeaderEnd(bytes, headerStart);
    if (headerEnd < 0 || headerEnd >= bytes.length) {
      chunks.push(bytes.slice(offset));
      break;
    }

    chunks.push(bytes.slice(offset, headerEnd));
    offset = headerEnd;
  }
  return chunks;
}

function findZmodemHexHeaderStart(bytes: Uint8Array, from: number) {
  for (let index = from; index + 5 < bytes.length; index += 1) {
    if (
      bytes[index] === ZMODEM_ASTERISK &&
      bytes[index + 1] === ZMODEM_ASTERISK &&
      bytes[index + 2] === ZMODEM_ZDLE &&
      bytes[index + 3] === ZMODEM_HEADER_B &&
      bytes[index + 4] === ASCII_ZERO &&
      (bytes[index + 5] === ASCII_ZERO || bytes[index + 5] === ASCII_ONE)
    ) {
      return index;
    }
  }
  return -1;
}

function findZmodemHexHeaderEnd(bytes: Uint8Array, headerStart: number) {
  const minLfIndex = headerStart + MIN_ZMODEM_HEX_HEADER_LF_OFFSET;
  const maxLfIndex = Math.min(bytes.length - 1, headerStart + MAX_ZMODEM_HEX_HEADER_LF_OFFSET);
  for (let index = minLfIndex; index <= maxLfIndex; index += 1) {
    if (bytes[index] !== ASCII_LINE_FEED && bytes[index] !== ASCII_HIGH_LINE_FEED) {
      continue;
    }
    let end = index + 1;
    if (bytes[end] === ASCII_XON) {
      end += 1;
    }
    return end;
  }
  return -1;
}

async function selectUploadFiles() {
  const selected = await open({
    title: "选择要通过 rz 上传的文件",
    multiple: true,
    directory: false,
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

async function selectDownloadDirectory() {
  const selected = await open({
    title: "选择 sz 下载保存目录",
    multiple: false,
    directory: true,
  });
  return typeof selected === "string" ? selected : null;
}

function decodeBase64Bytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
