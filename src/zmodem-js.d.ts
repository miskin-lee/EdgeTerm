declare module "zmodem.js" {
  export type Octets = number[] | Uint8Array | ArrayBuffer;

  export interface FileDetails {
    name: string;
    size?: number | null;
    mtime?: Date | number | null;
    mode?: number | null;
    files_remaining?: number | null;
    bytes_remaining?: number | null;
  }

  export interface Transfer {
    send(bytes: number[] | Uint8Array): void;
    end(bytes?: number[] | Uint8Array): Promise<void>;
    get_offset(): number;
    get_details(): FileDetails;
  }

  export interface Offer {
    accept(options?: {
      offset?: number;
      on_input?: (bytes: number[] | Uint8Array) => void;
    }): Promise<unknown>;
    skip(): Promise<unknown> | void;
    get_offset(): number;
    get_details(): FileDetails;
  }

  export interface SessionBase {
    type: "receive" | "send";
    on(event: "session_end", callback: () => void): this;
    abort(): void;
    aborted(): boolean;
    has_ended(): boolean;
  }

  export interface ReceiveSession extends SessionBase {
    type: "receive";
    on(event: "offer", callback: (offer: Offer) => void): this;
    on(event: "session_end", callback: () => void): this;
    start(): Promise<Offer | undefined>;
  }

  export interface SendSession extends SessionBase {
    type: "send";
    send_offer(details: FileDetails): Promise<Transfer | undefined>;
    close(): Promise<void>;
  }

  export type Session = ReceiveSession | SendSession;

  export interface Detection {
    confirm(): Session;
    deny(): void;
    is_valid(): boolean;
    get_session_role(): "receive" | "send";
  }

  export interface SentryOptions {
    to_terminal: (bytes: number[]) => void;
    sender: (bytes: number[]) => void;
    on_detect: (detection: Detection) => void;
    on_retract: () => void;
  }

  export class Sentry {
    constructor(options: SentryOptions);
    consume(bytes: Octets): void;
    get_confirmed_session(): Session | null;
  }

  const Zmodem: {
    Sentry: typeof Sentry;
  };

  export default Zmodem;
}
