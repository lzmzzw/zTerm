// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

export function reportZmodemDiagnostic(stage: string, header = "", runtimeSessionId = "") {
  // Diagnostics must never interrupt transfer processing, including in browser mocks.
  try {
    void Promise.resolve(invokeTauri("terminal_zmodem_diagnostic", { runtimeSessionId, stage, header })).catch(() => undefined);
  } catch { /* Optional diagnostic transport. */ }
}

export class ZmodemHexBodyObserver {
  private previous: number[] = [];
  private pending: number[] = [];
  private preamble = "";

  consume(bytes: Uint8Array): string[] {
    const headers: string[] = [];
    for (const byte of bytes) {
      if (this.pending.length) {
        const valid = this.pending.length === 1 ? byte === 48
          : this.pending.length === 2 ? byte === 48 || byte === 49 : isHexDigit(byte);
        if (valid) {
          this.pending.push(byte);
          if (this.pending.length === 15) {
            const body = this.pending.map((b) => b.toString(16).padStart(2, "0")).join(" ");
            headers.push(`${this.preamble} ${body}`.trim());
            this.pending = [];
          }
        } else this.pending = [];
      } else if (byte === 66) {
        this.pending = [byte];
        this.preamble = this.previous.map((b) => [24, 42, 27, 239, 191, 189].includes(b) ? b.toString(16).padStart(2, "0") : "other").join(" ");
      }
      this.previous.push(byte);
      if (this.previous.length > 3) this.previous.shift();
    }
    return headers;
  }
}

const PREFIX = [42, 42, 24, 66];

export class ZmodemStartupObserver {
  private pending: number[] = [];

  hasCandidate() {
    return this.pending.length > 0;
  }

  consume(bytes: Uint8Array): string[] {
    const headers: string[] = [];
    for (const byte of bytes) {
      if (this.pending.length < PREFIX.length) {
        this.pending.push(byte);
        while (!this.pending.every((value, index) => PREFIX[index] === value)) this.pending.shift();
        continue;
      }
      if (this.pending.length < 18 && isHexDigit(byte)) {
        this.pending.push(byte);
        continue;
      }
      if (this.pending.length >= 18 && [13, 10, 138, 17, 239, 191, 189].includes(byte)) {
        this.pending.push(byte);
        if (byte === 10 || byte === 138 || this.pending.length === 24) {
          headers.push(this.format());
          this.pending = [];
        }
        continue;
      }
      headers.push(`${this.format()} other`);
      this.pending = byte === 42 ? [42] : [];
    }
    return headers;
  }

  private format() {
    return this.pending.map((value) => value.toString(16).padStart(2, "0")).join(" ");
  }
}

function isHexDigit(byte: number) {
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102);
}
