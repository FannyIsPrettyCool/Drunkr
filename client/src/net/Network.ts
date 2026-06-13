import { decode, encode, type ClientMessage, type ServerMessage } from "@drunkr/shared";

type Handler = (msg: ServerMessage) => void;

/** Resolve the server URL: same host as the page, port 2567 (override via ?server=). */
function serverUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get("server");
  if (override) return override;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.hostname}:2567`;
}

export class Network {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(serverUrl());
      this.ws = ws;
      ws.onopen = () => {
        this.onOpen?.();
        resolve();
      };
      ws.onerror = () => reject(new Error("connection failed"));
      ws.onclose = () => this.onClose?.();
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = decode<ServerMessage>(ev.data);
        } catch {
          return;
        }
        for (const h of this.handlers) h(msg);
      };
    });
  }

  on(handler: Handler) {
    this.handlers.push(handler);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
