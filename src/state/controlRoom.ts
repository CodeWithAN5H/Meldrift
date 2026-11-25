import { create } from 'zustand';
import type {
  ClientEvent,
  ControlGrantView,
  ControlSessionView,
  ServerEvent,
} from '@shared/protocol';
import { getVoiceTransport } from '@/lib/voice/transport';
import { toIceServers } from '@/lib/voice/model';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import {
  HeldInput,
  InputBatcher,
  InjectionPump,
  type InputFrame,
} from '@/lib/control/input';
import { useStreamRoom } from '@/state/streamRoom';
import { ControlControllerSession, ControlHostSession } from '@/lib/control/session';
import { controlDesktop, type ArmedTarget, type ControlTarget } from '@/lib/control/desktop';
import { chooseTargetId } from '@/lib/control/targets';
import { isBlockedCombination, keyStrokeFor } from '@/lib/control/keys';

/* --------------------------------------------------------------------------
   Remote control and player handoff (M5).

   The server owns the authority: only the stream host can enable control,
   approve a request, revoke or hand off. This store is the host's and the
   controller's client half. It never assumes a grant from UI state alone:

   - the host arms one Windows window through Rust before approving, and Rust
     refuses injection unless that window is armed, focused and not paused;
   - the controller only sends after the user explicitly starts controlling and
     the host's data channel is open;
   - every revoke destroys the peer connection and releases all held keys and
     buttons on both sides.
   -------------------------------------------------------------------------- */

export type ControlLocal =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'connecting'
  | 'active'
  | 'revoked'
  | 'error';

export interface ControlRoomState {
  roomId: string | null;
  session: ControlSessionView | null;
  local: ControlLocal;
  grant: ControlGrantView | null;
  armed: ArmedTarget | null;
  targets: ControlTarget[];
  targetId: string;
  error: string | null;
  notice: string | null;
  latencyMs: number | null;
  heldCount: number;
  busy: boolean;
  enterRoom: (roomId: string) => void;
  leaveRoom: () => void;
  sync: () => void;
  refreshTargets: () => Promise<void>;
  setTargetId: (id: string) => void;
  enable: () => Promise<boolean>;
  disable: () => void;
  request: () => void;
  cancel: () => void;
  approve: (userId: string) => Promise<void>;
  reject: (userId: string) => void;
  revoke: (reason?: string) => void;
  release: () => void;
  startControlling: () => Promise<void>;
  stopControlling: (notify?: boolean) => void;
  resumeTarget: () => Promise<void>;
  emergencyStop: () => void;
  pressKey: (input: {
    code: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  }) => boolean;
  releaseKey: (code: string) => void;
  moveMouse: (dx: number, dy: number) => void;
  pressMouse: (button: 0 | 1 | 2, down: boolean) => void;
  scroll: (delta: number) => void;
  handleEvent: (event: ServerEvent) => void;
  onConnection: (status: 'connecting' | 'online' | 'reconnecting' | 'offline') => void;
  reset: () => void;
}

let hostSession: ControlHostSession | null = null;
let controllerSession: ControlControllerSession | null = null;
let pump: InjectionPump | null = null;
const batcher = new InputBatcher();
const held = new HeldInput();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listeners: Array<() => void> = [];
let listenersReady = false;

function selfId(): string {
  return getVoiceTransport()?.selfId ?? '';
}

function send(event: ClientEvent): boolean {
  return getVoiceTransport()?.send(event) ?? false;
}

function targetLabel(target: ControlTarget): string {
  return `${target.title} · ${target.process}`.slice(0, 120);
}

function iceServers(): RTCIceServer[] {
  const transport = getVoiceTransport();
  const settings = useWorkspace.getState().settings;
  return toIceServers(transport?.iceServers ?? [], {
    stunUrl: settings.voiceStunUrl,
    turnUrl: settings.voiceTurnUrl,
    turnUsername: settings.voiceTurnUsername,
    turnCredential: settings.voiceTurnCredential,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Remote control failed.');
}

function installDesktopListeners(): void {
  if (listenersReady || !controlDesktop.available()) return;
  listenersReady = true;
  void controlDesktop
    .onPaused((reason) => {
      const state = useControlRoom.getState();
      if (!state.armed) return;
      useControlRoom.setState({ armed: { ...state.armed, paused: true }, notice: reason });
      // Tell the room input is paused without ending the grant.
      if (state.roomId && state.grant) {
        send({
          t: 'control.active',
          roomId: state.roomId,
          grantId: state.grant.grantId,
          active: false,
        });
      }
      useUi.getState().pushToast(reason, 'info');
    })
    .then((off) => listeners.push(off));
  void controlDesktop
    .onInvalidated((reason) => {
      const state = useControlRoom.getState();
      if (!state.roomId) return;
      closeHostSession();
      void controlDesktop.end().catch(() => undefined);
      useControlRoom.setState({
        armed: null,
        grant: null,
        local: 'idle',
        notice: reason,
        error: reason,
      });
      // The target is gone; the grant must not survive it.
      send({ t: 'control.revoke', roomId: state.roomId });
      useUi.getState().pushToast(reason, 'error');
    })
    .then((off) => listeners.push(off));
  void controlDesktop
    .onEmergency(() => {
      useControlRoom.getState().emergencyStop();
    })
    .then((off) => listeners.push(off));
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!controllerSession) return;
  const frame = batcher.flush(performance.now());
  if (!frame) return;
  controllerSession.send(frame);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 8);
}

function releaseAllInputs(): void {
  const released = held.releaseAll();
  for (const key of released.keys) batcher.addWireKey(key);
  for (const button of released.buttons) batcher.addWireButton(button);
  flush();
  useControlRoom.setState({ heldCount: 0 });
}

function closeHostSession(): void {
  pump?.clear();
  pump = null;
  hostSession?.close();
  hostSession = null;
}

function stopControllerSession(): void {
  controllerSession?.stop();
  controllerSession = null;
  batcher.reset();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function sendActive(roomId: string, grantId: string, active: boolean): void {
  send({ t: 'control.active', roomId, grantId, active });
}

export const useControlRoom = create<ControlRoomState>((set, get) => ({
  roomId: null,
  session: null,
  local: 'idle',
  grant: null,
  armed: null,
  targets: [],
  targetId: '',
  error: null,
  notice: null,
  latencyMs: null,
  heldCount: 0,
  busy: false,

  enterRoom: (roomId) => {
    installDesktopListeners();
    if (get().roomId === roomId) {
      get().sync();
      return;
    }
    get().leaveRoom();
    set({
      roomId,
      session: null,
      local: 'idle',
      grant: null,
      armed: null,
      targets: [],
      targetId: '',
      error: null,
      notice: null,
      latencyMs: null,
      heldCount: 0,
      busy: false,
    });
    get().sync();
    if (controlDesktop.available()) void get().refreshTargets();
  },

  leaveRoom: () => {
    const state = get();
    if (controllerSession) {
      releaseAllInputs();
      if (state.roomId) send({ t: 'control.release', roomId: state.roomId });
      stopControllerSession();
    }
    if (hostSession) {
      if (state.roomId) send({ t: 'control.revoke', roomId: state.roomId });
      closeHostSession();
    }
    if (state.armed) void controlDesktop.end().catch(() => undefined);
    set({
      roomId: null,
      session: null,
      local: 'idle',
      grant: null,
      armed: null,
      error: null,
      notice: null,
      latencyMs: null,
      heldCount: 0,
      busy: false,
    });
  },

  sync: () => {
    const roomId = get().roomId;
    if (roomId) send({ t: 'control.sync', roomId });
  },

  refreshTargets: async () => {
    if (!controlDesktop.available()) return;
    try {
      const targets = await controlDesktop.targets();
      // Prefer the window that is currently being streamed: granting control of
      // the picture everyone is watching is the least surprising choice.
      const captureLabel = useStreamRoom.getState().captureLabel ?? '';
      // A closed window must not stay selected: approval would arm an id that
      // no longer exists and silently fail.
      const preferred = chooseTargetId(targets, get().targetId, captureLabel);
      set({ targets, targetId: preferred, error: null });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  setTargetId: (targetId) => set({ targetId }),

  enable: async () => {
    const state = get();
    if (!state.roomId) return false;
    if (!controlDesktop.available()) {
      set({ error: 'Remote control needs the Windows desktop app.' });
      return false;
    }
    const target = state.targets.find((item) => item.id === state.targetId);
    if (!target) {
      set({ error: 'Choose the window you are granting control of.' });
      return false;
    }
    const roomId = state.roomId;
    set({ busy: true, error: null });
    const ok = send({
      t: 'control.enable',
      roomId,
      enabled: true,
      targetLabel: targetLabel(target),
    });
    set({ busy: false });
    if (!ok) {
      set({ error: 'The server connection dropped.' });
      return false;
    }
    return true;
  },

  disable: () => {
    const state = get();
    if (state.roomId) send({ t: 'control.enable', roomId: state.roomId, enabled: false });
    closeHostSession();
    if (state.armed) void controlDesktop.end().catch(() => undefined);
    set({ armed: null, grant: null, local: 'idle', heldCount: 0, notice: null });
  },

  request: () => {
    const state = get();
    if (!state.roomId || !state.session?.enabled) return;
    if (!send({ t: 'control.request', roomId: state.roomId })) return;
    set({ local: 'requesting', error: null, notice: null });
  },

  cancel: () => {
    const state = get();
    if (state.roomId) send({ t: 'control.cancel', roomId: state.roomId });
    set({ local: 'idle', notice: null });
  },

  approve: async (userId) => {
    const state = get();
    if (!state.roomId || !state.session) return;
    if (!controlDesktop.available()) {
      set({ error: 'Remote control needs the Windows desktop app.' });
      return;
    }
    const target = state.targets.find((item) => item.id === state.targetId);
    if (!target) {
      set({ error: 'Choose the window you are granting control of.' });
      return;
    }
    if (state.session.targetLabel && state.session.targetLabel !== targetLabel(target)) {
      set({
        error: 'This window is not the one you enabled control for. Enable control for it first.',
      });
      return;
    }
    set({ busy: true, error: null });
    try {
      // Arming focuses the game and verifies it; it happens before approval so
      // no grant ever exists without a valid Windows target.
      const armed = await controlDesktop.arm(target.id);
      set({ armed });
    } catch (error) {
      const message = messageOf(error);
      set({ busy: false, error: message });
      useUi.getState().pushToast(message, 'error');
      return;
    }
    closeHostSession();
    if (!send({ t: 'control.approve', roomId: state.roomId, userId })) {
      set({ busy: false, error: 'The server connection dropped.' });
      void controlDesktop.end().catch(() => undefined);
      set({ armed: null });
      return;
    }
    set({ busy: false });
  },

  reject: (userId) => {
    const state = get();
    if (state.roomId) send({ t: 'control.reject', roomId: state.roomId, userId });
  },

  revoke: (reason) => {
    const state = get();
    if (state.roomId) send({ t: 'control.revoke', roomId: state.roomId });
    closeHostSession();
    if (state.armed) void controlDesktop.end().catch(() => undefined);
    set({
      armed: null,
      grant: null,
      local: 'idle',
      heldCount: 0,
      notice: reason ?? 'You revoked control.',
    });
  },

  release: () => {
    const state = get();
    if (!controllerSession) {
      set({ local: 'idle', grant: null });
      return;
    }
    releaseAllInputs();
    if (state.roomId) send({ t: 'control.release', roomId: state.roomId });
    stopControllerSession();
    set({ local: 'idle', grant: null, latencyMs: null, notice: 'You released control.' });
    useUi.getState().pushToast('You released control', 'info');
  },

  startControlling: async () => {
    const state = get();
    if (!state.grant || controllerSession) return;
    const transport = getVoiceTransport();
    if (!transport) {
      set({ error: 'Sign in to the server to control a game.', local: 'error' });
      return;
    }
    batcher.reset();
    set({ local: 'connecting', error: null, notice: null });
    controllerSession = new ControlControllerSession({
      iceServers: iceServers(),
      send: (signal) => {
        const roomId = get().roomId;
        if (roomId) send({ ...signal, roomId } as ClientEvent);
      },
      onOpen: () => {
        set({ local: 'active', notice: 'You have control. Esc releases it.' });
        useUi.getState().pushToast('You have control of the game', 'success');
      },
      onClosed: (reason) => {
        stopControllerSession();
        set({ local: 'revoked', notice: reason, latencyMs: null, grant: null });
        useUi.getState().pushToast(reason, 'error');
      },
      onLatency: (ms) => set({ latencyMs: ms }),
      onError: (message) => {
        stopControllerSession();
        set({ error: message, local: 'error', grant: null, latencyMs: null });
        useUi.getState().pushToast(message, 'error');
      },
    });
    await controllerSession.start(state.grant);
  },

  stopControlling: (notify = true) => {
    if (controllerSession) {
      releaseAllInputs();
      if (notify) {
        const roomId = get().roomId;
        if (roomId) send({ t: 'control.release', roomId });
      }
      stopControllerSession();
    }
    set({
      local: 'idle',
      latencyMs: null,
      heldCount: 0,
      grant: notify ? null : get().grant,
    });
  },

  resumeTarget: async () => {
    const state = get();
    if (!state.armed) return;
    try {
      const armed = await controlDesktop.resume();
      set({ armed, notice: 'Input resumed.' });
      if (state.roomId && state.grant) sendActive(state.roomId, state.grant.grantId, true);
    } catch (error) {
      const message = messageOf(error);
      set({ error: message });
      useUi.getState().pushToast(message, 'error');
    }
  },

  emergencyStop: () => {
    const state = get();
    if (state.roomId) {
      send({ t: 'control.revoke', roomId: state.roomId });
      send({ t: 'control.enable', roomId: state.roomId, enabled: false });
    }
    closeHostSession();
    if (state.armed) void controlDesktop.end().catch(() => undefined);
    set({
      armed: null,
      grant: null,
      local: 'idle',
      heldCount: 0,
      notice: 'Emergency stop: remote control is off.',
    });
    useUi.getState().pushToast('Emergency stop — remote control is off', 'error');
  },

  pressKey: (input) => {
    if (get().local !== 'active') return false;
    if (isBlockedCombination(input)) return false;
    const stroke = keyStrokeFor(input.code);
    if (!stroke) return false;
    if (!held.pressKey(input.code, stroke)) return false;
    batcher.addKey(stroke, true);
    flush();
    set({ heldCount: held.keyCount + held.buttonCount });
    return true;
  },

  releaseKey: (code) => {
    if (!held.releaseKey(code)) return;
    const stroke = keyStrokeFor(code);
    if (stroke) batcher.addKey(stroke, false);
    flush();
    set({ heldCount: held.keyCount + held.buttonCount });
  },

  moveMouse: (dx, dy) => {
    if (get().local !== 'active') return;
    batcher.addMove(dx, dy);
    scheduleFlush();
  },

  pressMouse: (button, down) => {
    const mapped = button === 0 ? 1 : button === 1 ? 3 : 2;
    if (down) {
      if (get().local !== 'active') return;
      if (!held.pressButton(mapped)) return;
    } else if (!held.releaseButton(mapped)) {
      return;
    }
    batcher.addButton(mapped, down);
    flush();
    set({ heldCount: held.keyCount + held.buttonCount });
  },

  scroll: (delta) => {
    if (get().local !== 'active') return;
    batcher.addWheel(delta);
    flush();
  },

  handleEvent: (event) => {
    switch (event.t) {
      case 'control.state': {
        const view = event.session;
        if (view.roomId !== get().roomId) return;
        const self = selfId();
        const isController = view.controller?.userId === self;
        const state = get();

        if (!isController && controllerSession) {
          releaseAllInputs();
          stopControllerSession();
          set({
            local: 'revoked',
            notice: 'Control ended.',
            latencyMs: null,
            grant: null,
          });
        } else if (!isController && state.local === 'granted') {
          set({ local: 'idle', grant: null });
        }
        if (!view.enabled) {
          closeHostSession();
          if (state.armed) void controlDesktop.end().catch(() => undefined);
          set({ armed: null, grant: null });
        }
        set({ session: view });
        return;
      }

      case 'control.granted': {
        const grant = event.grant;
        if (grant.roomId !== get().roomId) return;
        const self = selfId();
        const isHost = get().session?.host.userId === self;

        if (grant.controller.userId === self) {
          // The controller still has to press Start; a grant alone does not
          // capture or send any input.
          set({
            grant,
            local: 'granted',
            error: null,
            notice: `${grant.targetLabel} is yours once you start controlling.`,
          });
          useUi.getState().pushToast('The host granted you control', 'success');
          return;
        }

        if (isHost) {
          const armed = get().armed;
          if (!armed) {
            // Never hold a grant we cannot enforce locally.
            if (get().roomId) send({ t: 'control.revoke', roomId: grant.roomId });
            set({ error: 'Control was granted without an armed window.' });
            return;
          }
          closeHostSession();
          pump = new InjectionPump(
            (frame: InputFrame) => controlDesktop.inject(frame),
            (message) => {
              set({ error: message });
              useUi.getState().pushToast(message, 'error');
            },
          );
          hostSession = new ControlHostSession({
            iceServers: iceServers(),
            grant,
            send: (signal) => {
              const roomId = get().roomId;
              if (roomId) send({ ...signal, roomId } as ClientEvent);
            },
            onActive: () => {
              const state = get();
              if (state.roomId) sendActive(state.roomId, grant.grantId, true);
            },
            onClosed: (reason) => {
              const state = get();
              closeHostSession();
              if (state.roomId) send({ t: 'control.revoke', roomId: state.roomId });
              void controlDesktop.end().catch(() => undefined);
              set({ armed: null, grant: null, notice: reason, local: 'idle' });
            },
            onInput: (frame) => {
              if (!pump) return Promise.reject(new Error('Remote input is not armed.'));
              return pump.push(frame);
            },
            onError: (message) => {
              set({ error: message });
              useUi.getState().pushToast(message, 'error');
            },
          });
          set({ grant, notice: `${grant.controller.displayName} has control.`, error: null });
        }
        return;
      }

      case 'control.revoked': {
        if (event.roomId !== get().roomId) return;
        const self = selfId();
        const state = get();
        if (event.controllerId === self) {
          releaseAllInputs();
          stopControllerSession();
          set({
            local: 'revoked',
            latencyMs: null,
            grant: null,
            notice: event.reason,
          });
          useUi.getState().pushToast(event.reason, 'info');
        }
        if (state.session?.host.userId === self) {
          closeHostSession();
          if (state.armed) void controlDesktop.end().catch(() => undefined);
          set({ armed: null, grant: null, local: 'idle', notice: event.reason });
        }
        return;
      }

      case 'control.offer': {
        if (event.roomId !== get().roomId || !hostSession) return;
        void hostSession.handleOffer(event.grantId, event.sdp);
        return;
      }

      case 'control.answer': {
        if (event.roomId !== get().roomId || !controllerSession) return;
        void controllerSession.handleAnswer(event.grantId, event.sdp);
        return;
      }

      case 'control.ice': {
        if (event.roomId !== get().roomId) return;
        if (hostSession) void hostSession.handleIce(event.grantId, event.candidate);
        else if (controllerSession) {
          void controllerSession.handleIce(event.grantId, event.candidate);
        }
        return;
      }

      case 'control.error': {
        if (event.roomId && event.roomId !== get().roomId) return;
        const state = get();
        // A rejected approval must not leave the game armed and focused with no
        // session to use it.
        if (state.armed && !hostSession) {
          void controlDesktop.end().catch(() => undefined);
          set({ armed: null });
        }
        set({ error: event.error });
        useUi.getState().pushToast(event.error, 'error');
        return;
      }

      default:
        return;
    }
  },

  onConnection: (status) => {
    if (status === 'online') {
      get().sync();
      return;
    }
    if (controllerSession) {
      releaseAllInputs();
      stopControllerSession();
      set({
        local: 'revoked',
        grant: null,
        latencyMs: null,
        notice: 'Your connection dropped, so control ended.',
      });
    }
    if (hostSession) {
      closeHostSession();
      void controlDesktop.end().catch(() => undefined);
      set({
        armed: null,
        grant: null,
        notice: 'Your connection dropped, so remote control ended.',
      });
    }
  },

  reset: () => {
    get().leaveRoom();
    for (const off of listeners) off();
    listeners = [];
    listenersReady = false;
  },
}));
