// Author: Liz
declare module "zmodem.js/src/zmodem_browser" {
  export interface ZmodemDetection {
    confirm: () => ZmodemSession;
    deny: () => void;
  }

  export interface ZmodemSentryOptions {
    to_terminal: (octets: number[] | Uint8Array) => void;
    sender: (octets: number[] | Uint8Array) => void;
    on_detect: (detection: ZmodemDetection) => void;
    on_retract?: () => void;
  }

  export interface ZmodemSentry {
    consume: (octets: number[] | Uint8Array) => void;
  }

  export interface ZmodemOfferDetails {
    name: string;
    size?: number;
    mtime?: Date | number;
    mode?: number;
    serial?: number;
    files_remaining?: number;
    bytes_remaining?: number;
  }

  export interface ZmodemOffer {
    get_details: () => ZmodemOfferDetails;
    accept: (options?: { on_input?: "spool_uint8array" | "spool_array" | ((octets: Uint8Array) => void) }) => Promise<Array<Uint8Array | number[]>>;
    skip: () => void;
  }

  export interface ZmodemTransfer {
    get_offset: () => number;
    send: (octets: Uint8Array | number[]) => void;
    end: (octets?: Uint8Array | number[]) => Promise<void>;
  }

  export interface ZmodemSendOffer {
    name: string;
    size?: number;
    mtime?: Date | number;
    mode?: number;
    files_remaining?: number;
    bytes_remaining?: number;
  }

  export interface ZmodemSession {
    type: "send" | "receive";
    on: (eventName: "offer" | "receive" | "session_end" | "garbage", handler: (...args: any[]) => void) => ZmodemSession;
    start: () => void;
    close: () => Promise<void>;
    abort?: () => void;
    send_offer: (offer: ZmodemSendOffer) => Promise<ZmodemTransfer | undefined>;
  }

  export interface ZmodemModule {
    Sentry: new (options: ZmodemSentryOptions) => ZmodemSentry;
    DEBUG: boolean;
  }

  const Zmodem: ZmodemModule;
  export default Zmodem;
}
