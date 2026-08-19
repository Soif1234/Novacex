declare module 'ws' {
  import { EventEmitter } from 'events';
  import { Server as HttpServer, IncomingMessage } from 'http';
  import { Duplex } from 'stream';

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readonly CONNECTING: number;
    readonly OPEN: number;
    readonly CLOSING: number;
    readonly CLOSED: number;

    readyState: number;
    bufferedAmount: number;
    protocol: string;
    url: string;

    constructor(address: string | URL, protocols?: string | string[], options?: any);

    close(code?: number, data?: string | Buffer): void;
    ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void;
    pong(data?: any, mask?: boolean, cb?: (err: Error) => void): void;
    send(data: any, cb?: (err?: Error) => void): void;
    send(data: any, options: { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean }, cb?: (err?: Error) => void): void;
    terminate(): void;

    on(event: 'close', listener: (this: WebSocket, code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (this: WebSocket, err: Error) => void): this;
    on(event: 'message', listener: (this: WebSocket, data: any, isBinary: boolean) => void): this;
    on(event: 'open', listener: (this: WebSocket) => void): this;
    on(event: 'ping' | 'pong', listener: (this: WebSocket, data: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
  }

  export interface ServerOptions {
    host?: string;
    port?: number;
    backlog?: number;
    server?: HttpServer;
    verifyClient?: (info: { origin: string; secure: boolean; req: IncomingMessage }, callback: (res: boolean, code?: number, message?: string) => void) => void;
    handleProtocols?: (protocols: Set<string>, request: IncomingMessage) => string | false;
    path?: string;
    noServer?: boolean;
    clientTracking?: boolean;
    perMessageDeflate?: boolean | any;
    maxPayload?: number;
    skipUTF8Validation?: boolean;
  }

  export class WebSocketServer extends EventEmitter {
    options: ServerOptions;
    path: string;
    clients: Set<WebSocket>;

    constructor(options?: ServerOptions, callback?: () => void);

    close(cb?: (err?: Error) => void): void;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (client: WebSocket, request: IncomingMessage) => void): void;
    shouldHandle(request: IncomingMessage): boolean;

    on(event: 'connection', listener: (this: WebSocketServer, socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'error', listener: (this: WebSocketServer, error: Error) => void): this;
    on(event: 'headers', listener: (this: WebSocketServer, headers: string[], request: IncomingMessage) => void): this;
    on(event: 'close' | 'listening', listener: (this: WebSocketServer) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
  }

  export default WebSocket;
}
