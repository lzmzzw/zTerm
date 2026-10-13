// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";
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
import { reportZmodemDiagnostic, ZmodemStartupObserver, ZmodemHexBodyObserver } from "./zmodemDiagnostics";

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
export const ZMODEM_SINGLE_FILE_LIMIT_BYTES = 32 * 1024 * 1024;
const ZMODEM_SINGLE_FILE_LIMIT_LABEL = "32 MiB";
const PROGRESS_BAR_WIDTH = 20;
const UNKNOWN_TOTAL_PROGRESS_STEP_BYTES = 256 * 1024;
const ZMODEM_ASTERISK = 42;
const ZMODEM_ZDLE = 24;
const ZMODEM_HEADER_B = 66;
const ASCII_ZERO = 48;
const ASCII_ONE = 49;
const ASCII_LINE_FEED = 10;
const ASCII_HIGH_LINE_FEED = 0x8a;
const ASCII_XON = 0x11;
const ZMODEM_OVER_AND_OUT = [79, 79] as const;
const MIN_ZMODEM_HEX_HEADER_LF_OFFSET = 18;
const MAX_ZMODEM_HEX_HEADER_LF_OFFSET = 19;
const ZMODEM_ZRQINIT_TYPE = [ASCII_ZERO, ASCII_ZERO] as const;

export function consumeTerminalZmodemData(
  event: TerminalZmodemDataEvent,
  dependencies: ZmodemTransferDependencies,
) {
  if (!event.dataBase64) {
    if (event.data.includes("**\x18B")) reportZmodemDiagnostic("frontend-missing-base64", "", event.runtimeSessionId);
    dependencies.appendOutput(event.runtimeSessionId, event.data);
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Bytes(event.dataBase64);
  } catch (error) {
    discardTerminalZmodemController(event.runtimeSessionId);
    dependencies.appendOutput(
      event.runtimeSessionId,
      `\r\nZMODEM 原始输出解码失败：${stringifiedErrorMessage(error)}\r\n`,
    );
    return;
  }
  if (!bytes.length) {
    return;
  }

  const controller = getController(event.runtimeSessionId, dependencies);
  if (!controller.consume(bytes)) {
    controllers.delete(event.runtimeSessionId);
  }
}

export function releaseTerminalZmodemRuntime(runtimeSessionId: string) {
  discardTerminalZmodemController(runtimeSessionId);
}

export function clearTerminalZmodemControllersForTest() {
  for (const controller of controllers.values()) {
    controller.dispose();
  }
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

function discardTerminalZmodemController(runtimeSessionId: string) {
  const controller = controllers.get(runtimeSessionId);
  controller?.dispose();
  controllers.delete(runtimeSessionId);
}

class ZmodemRuntimeController {
  private hexBodyObserver = new ZmodemHexBodyObserver();
  private startupObserver = new ZmodemStartupObserver();
  private dependencies: ZmodemTransferDependencies;
  private sentry: ZmodemSentry;
  private textDecoder = new TextDecoder("utf-8", { fatal: false });
  private activeSession: ZmodemSession | null = null;
  private pendingReceiveOverAndOut: number[] | null = null;
  private pendingDownloadStartupBytes: number[] = [];
  private awaitingDownloadDirectory = false;
  private awaitingUploadOffer = false;
  private disposed = false;
  private aborting = false;
  private outboundGeneration = 0;
  private outboundWrites = Promise.resolve();

  constructor(private readonly runtimeSessionId: string, dependencies: ZmodemTransferDependencies) {
    this.dependencies = withDefaultDependencies(dependencies);
    this.sentry = this.createSentry();
    this.diagnose("frontend-ready");
  }

  private diagnose(stage: string, header = "") {
    reportZmodemDiagnostic(stage, header, this.runtimeSessionId);
  }

  private createSentry(): ZmodemSentry {
    const options: ZmodemSentryOptions = {
      to_terminal: (octets) => this.appendOutput(this.octetsToText(octets)),
      sender: (octets) => this.queueOutboundBytes(octets),
      on_detect: (detection) => {
        void this.handleDetection(detection);
      },
      on_retract: () => {
        this.appendOutput("\r\n已取消检测到的传输。\r\n");
      },
    };
    return this.dependencies.createSentry?.(options) ?? new Zmodem.Sentry(options);
  }

  updateDependencies(dependencies: ZmodemTransferDependencies) {
    this.dependencies = withDefaultDependencies(dependencies);
  }

  consume(bytes: Uint8Array): boolean {
    if (this.disposed) return false;
    if (!this.activeSession) {
      for (const body of this.hexBodyObserver.consume(bytes)) this.diagnose("frontend-body", body);
      const hadCandidate = this.startupObserver.hasCandidate();
      const headers = this.startupObserver.consume(bytes);
      if (hadCandidate || this.startupObserver.hasCandidate() || headers.length) {
        const chunkLength = [24, 16, 8, 0].map((shift) => ((bytes.length >>> shift) & 255).toString(16).padStart(2, "0")).join(" ");
        this.diagnose("frontend-fragment", chunkLength);
      }
      for (const header of headers) this.diagnose("frontend-input", header);
    }
    try {
      const completedBytes = this.completeMissingReceiveOverAndOut(bytes);
      if (!completedBytes) return true;
      const wasAwaitingDownloadDirectory = this.awaitingDownloadDirectory;
      const chunks = wasAwaitingDownloadDirectory
        ? this.filterRepeatedDownloadZrqinit(completedBytes)
        : this.pendingDownloadStartupBytes.length > 0
          ? this.completePendingDownloadZrqinit(completedBytes)
        : this.activeSession ? [completedBytes] : splitCoalescedZmodemStartupBytes(completedBytes);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const filteredChunks = !wasAwaitingDownloadDirectory && index > 0 && this.awaitingDownloadDirectory
          ? this.filterRepeatedDownloadZrqinit(chunk)
          : [chunk];
        for (const filteredChunk of filteredChunks) {
          if (this.awaitingUploadOffer && isStandaloneZmodemStartupHeader(filteredChunk)) {
            continue;
          }
          this.sentry.consume(Array.from(filteredChunk));
        }
      }
      return true;
    } catch (error) {
      this.diagnose("frontend-parse-error");
      this.appendOutput(`\r\n传输解析失败：${stringifiedErrorMessage(error)}\r\n`);
      this.abortAndDiscard();
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.pendingReceiveOverAndOut = null;
    this.pendingDownloadStartupBytes = [];
    this.awaitingDownloadDirectory = false;
    this.awaitingUploadOffer = false;
    if (this.activeSession?.abort) {
      this.aborting = true;
      try {
        this.activeSession.abort();
      } catch {
        // A terminated session may reject a second abort; cleanup still continues.
      } finally {
        this.aborting = false;
      }
    }
    this.activeSession = null;
    this.disposed = true;
    this.outboundGeneration += 1;
    this.textDecoder = new TextDecoder("utf-8", { fatal: false });
  }

  private async handleDetection(detection: ZmodemDetection) {
    if (this.disposed || this.activeSession) {
      detection.deny();
      return;
    }

    const session = detection.confirm();
    this.diagnose(session.type === "send" ? "frontend-send" : "frontend-receive");
    this.activeSession = session;
    try {
      if (session.type === "send") {
        await this.runUpload(session);
      } else {
        await this.runDownload(session);
      }
    } catch (error) {
      if (this.disposed) return;
      this.appendOutput(`\r\n传输失败：${stringifiedErrorMessage(error)}\r\n`);
      this.abortAndDiscard();
    }
  }

  private async runUpload(session: ZmodemSession) {
    this.appendOutput("\r\nrz 请求上传文件，正在选择本机文件...\r\n");
    this.awaitingUploadOffer = true;
    const paths = await this.dependencies.selectUploadFiles?.();
    this.ensureActiveSession(session);
    if (!paths?.length) {
      this.appendOutput("未选择文件，上传已取消。\r\n");
      this.abortAndDiscard();
      return;
    }

    const files = await this.dependencies.readLocalFiles?.(paths);
    this.ensureActiveSession(session);
    if (!files?.length) {
      this.appendOutput("未读取到可上传文件。\r\n");
      this.abortAndDiscard();
      return;
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let remainingBytes = totalBytes;
    for (let index = 0; index < files.length; index += 1) {
      this.ensureActiveSession(session);
      const file = files[index];
      this.awaitingUploadOffer = false;
      const transfer = await session.send_offer({
        name: file.name,
        size: file.size,
        mtime: new Date(file.mtime_ms),
        files_remaining: files.length - index,
        bytes_remaining: remainingBytes,
      });
      this.ensureActiveSession(session);
      remainingBytes -= file.size;
      if (!transfer) {
        this.appendOutput(`远端跳过 ${file.name}。\r\n`);
        continue;
      }
      const progress = createTransferProgress("上传", file.name, file.size, (output) => this.appendOutput(output));
      progress.update(transfer.get_offset());
      await sendFileBytes(transfer, Uint8Array.from(file.data), progress.update);
      await this.outboundWrites;
      this.ensureActiveSession(session);
      progress.finish(file.data.length);
    }

    await session.close();
    await this.outboundWrites;
    this.ensureActiveSession(session);
    this.appendOutput("上传完成。\r\n");
    this.activeSession = null;
  }

  private async runDownload(session: ZmodemSession) {
    this.appendOutput("\r\nsz 请求下载文件，正在选择保存目录...\r\n");
    this.awaitingDownloadDirectory = true;
    let directory: string | null | undefined;
    try {
      directory = await this.dependencies.selectDownloadDirectory?.();
    } finally {
      this.awaitingDownloadDirectory = false;
    }
    this.ensureActiveSession(session);
    if (!directory) {
      this.appendOutput("未选择保存目录，下载已取消。\r\n");
      this.abortAndDiscard();
      return;
    }

    let savedCount = 0;
    const saveTasks: Array<Promise<void>> = [];
    session.on("receive", (value: unknown) => {
      if (isZfinHeader(value)) {
        this.pendingReceiveOverAndOut = [];
      }
    });
    session.on("offer", (offer: ZmodemOffer) => {
      if (!this.isActiveSession(session)) return;
      const details = offer.get_details();
      if (isKnownOversizedZmodemFile(details.size)) {
        try {
          offer.skip();
        } catch {
          session.abort?.();
        }
        this.appendOutput(
          `已跳过 ${details.name}：文件大小 ${formatBytes(details.size)} 超过 ZMODEM 单文件限制 ${ZMODEM_SINGLE_FILE_LIMIT_LABEL}，请使用 SFTP 文件面板下载。\r\n`,
        );
        return;
      }
      const progress = createTransferProgress("下载", details.name, details.size, (output) => this.appendOutput(output));
      let receivedBytes = 0;
      let limitExceeded = false;
      let progressFinished = false;
      const finishProgress = () => {
        if (progressFinished) return;
        progressFinished = true;
        progress.finish(receivedBytes);
      };
      progress.update(0);
      offer.on("input", (payload) => {
        receivedBytes += payload.length;
        if (receivedBytes > ZMODEM_SINGLE_FILE_LIMIT_BYTES) {
          if (!limitExceeded) {
            limitExceeded = true;
            try {
              offer.skip();
            } catch {
              session.abort?.();
            }
            this.appendOutput(
              `已中止 ${details.name}：实际接收数据超过 ZMODEM 单文件限制 ${ZMODEM_SINGLE_FILE_LIMIT_LABEL}，请使用 SFTP 文件面板下载。\r\n`,
            );
          }
          return;
        }
        progress.update(receivedBytes);
      });
      const saveTask = offer
        .accept({ on_input: "spool_uint8array" })
        .then((payloads) => {
          if (limitExceeded || !this.isActiveSession(session)) return undefined;
          finishProgress();
          return this.dependencies.saveFile?.(directory, details.name, flattenPayloads(payloads));
        })
        .then((saved) => {
          if (!this.isActiveSession(session)) return;
          if (!saved) return;
          savedCount += 1;
          this.appendOutput(`已保存 ${details.name} -> ${saved.path}\r\n`);
        })
        .catch((error) => {
          if (!this.isActiveSession(session)) return;
          if (limitExceeded) return;
          finishProgress();
          this.appendOutput(`保存 ${details.name} 失败：${stringifiedErrorMessage(error)}\r\n`);
        });
      saveTasks.push(saveTask);
    });
    session.on("session_end", () => {
      if (!this.isActiveSession(session)) return;
      this.pendingReceiveOverAndOut = null;
      void Promise.allSettled(saveTasks).then(() => {
        if (!this.isActiveSession(session)) return;
        this.appendOutput(`下载完成，共 ${savedCount} 个文件。\r\n`);
        this.activeSession = null;
      });
    });
    session.start();
  }

  private completeMissingReceiveOverAndOut(bytes: Uint8Array) {
    if (this.pendingReceiveOverAndOut === null) return bytes;

    const combined = [...this.pendingReceiveOverAndOut, ...bytes];
    if (combined.length === 1 && combined[0] === ZMODEM_OVER_AND_OUT[0]) {
      this.pendingReceiveOverAndOut = combined;
      return null;
    }

    this.pendingReceiveOverAndOut = null;
    if (combined[0] === ZMODEM_OVER_AND_OUT[0] && combined[1] === ZMODEM_OVER_AND_OUT[1]) {
      return Uint8Array.from(combined);
    }
    if (combined[0] === ZMODEM_OVER_AND_OUT[0]) {
      return Uint8Array.from([ZMODEM_OVER_AND_OUT[0], ...combined]);
    }
    return Uint8Array.from([...ZMODEM_OVER_AND_OUT, ...combined]);
  }

  private filterRepeatedDownloadZrqinit(bytes: Uint8Array) {
    const combined = Uint8Array.from([...this.pendingDownloadStartupBytes, ...bytes]);
    this.pendingDownloadStartupBytes = [];
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset < combined.length) {
      const headerStart = findZmodemHexHeaderStart(combined, offset);
      if (headerStart < 0) {
        const pendingStart = findTrailingZrqinitPrefixStart(combined, offset);
        const end = pendingStart < 0 ? combined.length : pendingStart;
        if (end > offset) chunks.push(combined.slice(offset, end));
        if (pendingStart >= 0) this.pendingDownloadStartupBytes = Array.from(combined.slice(pendingStart));
        break;
      }

      if (headerStart > offset) chunks.push(combined.slice(offset, headerStart));
      const headerEnd = findZmodemHexHeaderEnd(combined, headerStart);
      if (headerEnd < 0) {
        const candidate = combined.slice(headerStart);
        if (candidate.length <= MAX_ZMODEM_HEX_HEADER_LF_OFFSET) {
          this.pendingDownloadStartupBytes = Array.from(candidate);
        } else {
          chunks.push(candidate);
        }
        break;
      }

      const header = combined.slice(headerStart, headerEnd);
      if (!isZrqinitHexHeader(header)) chunks.push(header);
      offset = headerEnd;
    }

    return chunks;
  }

  private completePendingDownloadZrqinit(bytes: Uint8Array) {
    const combined = Uint8Array.from([...this.pendingDownloadStartupBytes, ...bytes]);
    this.pendingDownloadStartupBytes = [];
    if (findZmodemHexHeaderStart(combined, 0) !== 0) {
      if (findTrailingZrqinitPrefixStart(combined, 0) === 0) {
        this.pendingDownloadStartupBytes = Array.from(combined);
        return [];
      }
      return [combined];
    }

    const headerEnd = findZmodemHexHeaderEnd(combined, 0);
    if (headerEnd < 0) {
      if (combined.length <= MAX_ZMODEM_HEX_HEADER_LF_OFFSET) {
        this.pendingDownloadStartupBytes = Array.from(combined);
        return [];
      }
      return [combined];
    }

    if (!isZrqinitHexHeader(combined.slice(0, headerEnd))) {
      return [combined];
    }
    return headerEnd < combined.length ? [combined.slice(headerEnd)] : [];
  }

  private appendOutput(data: string) {
    if (!data || this.disposed) return;
    this.dependencies.appendOutput(this.runtimeSessionId, data);
  }

  private octetsToText(octets: number[] | Uint8Array) {
    return this.textDecoder.decode(octets instanceof Uint8Array ? octets : Uint8Array.from(octets), { stream: true });
  }

  private queueOutboundBytes(octets: number[] | Uint8Array) {
    const bytes = Array.from(octets);
    const generation = this.outboundGeneration;
    const isAbortSequence = this.aborting;
    this.outboundWrites = this.outboundWrites
      .catch(() => undefined)
      .then(async () => {
        if (!isAbortSequence && (this.disposed || generation !== this.outboundGeneration)) return;
        await this.dependencies.sendBytes?.(this.runtimeSessionId, bytes);
      })
      .catch((error) => {
        if (!isAbortSequence && (this.disposed || generation !== this.outboundGeneration)) return;
        this.appendOutput(`\r\nZMODEM 向远端发送失败：${stringifiedErrorMessage(error)}\r\n`);
        if (!this.disposed) {
          this.abortAndDiscard();
        }
      });
  }

  private isActiveSession(session: ZmodemSession) {
    return !this.disposed && this.activeSession === session;
  }

  private ensureActiveSession(session: ZmodemSession) {
    if (!this.isActiveSession(session)) {
      throw new Error("ZMODEM 传输已取消");
    }
  }

  private abortAndDiscard() {
    this.dispose();
    if (controllers.get(this.runtimeSessionId) === this) {
      controllers.delete(this.runtimeSessionId);
    }
  }
}

function isZfinHeader(value: unknown): value is { NAME: "ZFIN" } {
  return typeof value === "object" && value !== null && "NAME" in value && value.NAME === "ZFIN";
}

function isKnownOversizedZmodemFile(size: number | undefined): size is number {
  return size !== undefined && Number.isFinite(size) && size > ZMODEM_SINGLE_FILE_LIMIT_BYTES;
}

async function sendFileBytes(
  transfer: ZmodemTransfer,
  bytes: Uint8Array,
  onProgress?: (transferredBytes: number) => void,
) {
  let offset = Math.max(0, transfer.get_offset());
  while (offset < bytes.length) {
    const nextOffset = Math.min(bytes.length, offset + SEND_CHUNK_BYTES);
    transfer.send(bytes.slice(offset, nextOffset));
    offset = nextOffset;
    onProgress?.(offset);
  }
  await transfer.end(new Uint8Array());
}

function createTransferProgress(
  direction: "上传" | "下载",
  fileName: string,
  totalBytes: number | undefined,
  appendOutput: (output: string) => void,
) {
  const knownTotal = Number.isFinite(totalBytes) && totalBytes !== undefined
    ? Math.max(0, totalBytes)
    : null;
  let lastRenderKey: string | null = null;

  const render = (transferredBytes: number, finished: boolean) => {
    const transferred = Math.max(0, transferredBytes);
    const ratio = knownTotal === null
      ? (finished ? 1 : null)
      : (knownTotal === 0 ? 1 : Math.min(1, transferred / knownTotal));
    const filledCells = ratio === null ? 0 : Math.floor(ratio * PROGRESS_BAR_WIDTH);
    const renderKey = ratio === null
      ? `unknown:${Math.floor(transferred / UNKNOWN_TOTAL_PROGRESS_STEP_BYTES)}`
      : `known:${filledCells}`;
    if (!finished && renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;

    const bar = `${"█".repeat(filledCells)}${"░".repeat(PROGRESS_BAR_WIDTH - filledCells)}`;
    const percentage = ratio === null ? " --" : String(Math.floor(ratio * 100)).padStart(3, " ");
    const size = knownTotal === null
      ? formatBytes(transferred)
      : `${formatBytes(Math.min(transferred, knownTotal))} / ${formatBytes(knownTotal)}`;
    appendOutput(`\x1b[2K\r${direction} ${fileName} [${bar}] ${percentage}% ${size}${finished ? "\r\n" : ""}`);
  };

  return {
    update: (transferredBytes: number) => render(transferredBytes, false),
    finish: (transferredBytes: number) => render(transferredBytes, true),
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
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
      ((runtimeSessionId, data) => invokeTauri("terminal_write_bytes", { runtimeSessionId, data })),
    selectUploadFiles: dependencies.selectUploadFiles ?? selectUploadFiles,
    selectDownloadDirectory: dependencies.selectDownloadDirectory ?? selectDownloadDirectory,
    readLocalFiles:
      dependencies.readLocalFiles ??
      ((paths) => invokeTauri<TerminalZmodemLocalFile[]>("terminal_zmodem_read_files", { paths })),
    saveFile:
      dependencies.saveFile ??
      ((directory, fileName, data) =>
        invokeTauri<TerminalZmodemSavedFile>("terminal_zmodem_save_file", { directory, fileName, data })),
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

function isStandaloneZmodemStartupHeader(bytes: Uint8Array) {
  return findZmodemHexHeaderStart(bytes, 0) === 0 && findZmodemHexHeaderEnd(bytes, 0) === bytes.length;
}

function isZrqinitHexHeader(bytes: Uint8Array) {
  return bytes[4] === ZMODEM_ZRQINIT_TYPE[0] && bytes[5] === ZMODEM_ZRQINIT_TYPE[1];
}

function findTrailingZrqinitPrefixStart(bytes: Uint8Array, from: number) {
  const prefix = [ZMODEM_ASTERISK, ZMODEM_ASTERISK, ZMODEM_ZDLE, ZMODEM_HEADER_B, ASCII_ZERO, ASCII_ZERO];
  const minimumStart = Math.max(from, bytes.length - prefix.length + 1);
  for (let start = minimumStart; start < bytes.length; start += 1) {
    const length = bytes.length - start;
    if (prefix.slice(0, length).every((value, index) => bytes[start + index] === value)) return start;
  }
  return -1;
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
