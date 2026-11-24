import type { ClientEvent, MessageScope, MessageView, ServerEvent } from '@shared/protocol';

/* --------------------------------------------------------------------------
   The realtime channel.

   Responsibilities kept deliberately small: connect, send, receive, and keep
   itself alive. It never writes to a store; handlers do that. If the socket
   drops it retries with capped exponential backoff and reports its status, so
   the UI can say "reconnecting" honestly instead of showing a stale green dot.
   -------------------------------------------------------------------------- */

export type SocketStatus = 'connecting' | 'online' | 'reconnecting' | 'closed';

export interface RealtimeHandlers {
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: SocketStatus) => void;
}

const HEARTBEAT_MS = 25_000;
const SILENCE_LIMIT_MS = 70_000;
const ACK_TIMEOUT_MS = 15_000;
const BACKOFF_MS = [800, 1_600, 3_200, 6_400, 12_000, 20_000];

interface PendingSend {
  resolve: (message: MessageView) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RealtimeConnection {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = 0;
  private pending = new Map<string, PendingSend>();

  constructor(
    private readonly url: string,
    private readonly handlers: RealtimeHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.rejectPending('Disconnected');
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
    this.handlers.onStatus('closed');
  }

  send(event: ClientEvent): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a message and resolves when the server acknowledges the write, so
   * the UI never shows an unconfirmed message as delivered.
   */
  sendMessage(scopeType: MessageScope, scopeId: string, body: string): Promise<MessageView> {
    const clientId = crypto.randomUUID();
    const sent = this.send({ t: 'message.send', clientId, scopeType, scopeId, body });
    if (!sent) return Promise.reject(new Error('Not connected to the server'));

    return new Promise<MessageView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientId);
        reject(new Error('The server did not confirm the message'));
      }, ACK_TIMEOUT_MS);
      this.pending.set(clientId, { resolve, reject, timer });
    });
  }

  private open(): void {
    this.handlers.onStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.lastSeen = Date.now();
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      this.lastSeen = Date.now();
      let payload: ServerEvent;
      try {
        payload = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return;
      }

      if (payload.t === 'ready') {
        this.attempts = 0;
        this.handlers.onStatus('online');
      }
      if (payload.t === 'pong') return;
      if (payload.t === 'message.ack') {
        const pending = this.pending.get(payload.clientId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(payload.clientId);
          pending.resolve(payload.message);
        }
        return;
      }
      if (payload.t === 'message.error') {
        const pending = this.pending.get(payload.clientId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(payload.clientId);
          pending.reject(new Error(payload.error));
        }
        return;
      }
      this.handlers.onEvent(payload);
    };

    socket.onerror = () => {
      // Browsers always follow this with onclose; reconnect happens there.
    };

    socket.onclose = () => {
      this.clearHeartbeat();
      this.rejectPending('Connection lost');
      this.socket = null;
      if (this.stopped) return;
      this.attempts += 1;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.handlers.onStatus('reconnecting');
    const base = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    const jitter = base * (0.85 + Math.random() * 0.3);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, jitter);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > SILENCE_LIMIT_MS) {
        // The socket looks open but nothing is coming back: force a reconnect.
        this.socket.close();
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private rejectPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
