import { create } from 'zustand';

export type View =
  | { kind: 'home' }
  | { kind: 'friends'; friendId?: string }
  | { kind: 'rooms' }
  | { kind: 'games' }
  | { kind: 'settings'; section?: string }
  | { kind: 'room'; roomId: string };

export type ModalKind =
  | 'create-room'
  | 'join-room'
  | 'add-friend'
  | 'add-game'
  | 'mic-test'
  | 'delete-room'
  | 'remove-friend'
  | 'clear-data';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
}

interface UiState {
  view: View;
  history: View[];
  contextOpen: boolean;
  paletteOpen: boolean;
  modal: ModalKind | null;
  modalPayload: Record<string, string> | null;
  searchQuery: string;
  toasts: Toast[];
  navigate: (view: View) => void;
  goBack: () => boolean;
  setContextOpen: (open: boolean) => void;
  toggleContext: () => void;
  setPaletteOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  openModal: (modal: ModalKind, payload?: Record<string, string>) => void;
  closeModal: () => void;
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: string) => void;
}

let toastSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  view: { kind: 'home' },
  history: [],
  contextOpen: true,
  paletteOpen: false,
  modal: null,
  modalPayload: null,
  searchQuery: '',
  toasts: [],

  navigate: (view) => {
    const current = get().view;
    if (current.kind === view.kind && JSON.stringify(current) === JSON.stringify(view)) return;
    set((state) => ({ view, history: [...state.history, current].slice(-40) }));
  },

  goBack: () => {
    const { history } = get();
    if (history.length === 0) return false;
    const previous = history[history.length - 1];
    set({ view: previous, history: history.slice(0, -1) });
    return true;
  },

  setContextOpen: (open) => set({ contextOpen: open }),
  toggleContext: () => set((state) => ({ contextOpen: !state.contextOpen })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query, paletteOpen: query.length > 0 }),
  openModal: (modal, payload) => set({ modal, modalPayload: payload ?? null }),
  closeModal: () => set({ modal: null, modalPayload: null }),

  pushToast: (message, tone = 'info') => {
    toastSeq += 1;
    const toast: Toast = { id: `toast-${toastSeq}`, message, tone };
    set((state) => ({ toasts: [...state.toasts.slice(-2), toast] }));
    window.setTimeout(() => {
      useUi.getState().dismissToast(toast.id);
    }, 3800);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function viewKey(view: View): string {
  switch (view.kind) {
    case 'room':
      return `room:${view.roomId}`;
    case 'friends':
      return `friends:${view.friendId ?? ''}`;
    case 'settings':
      return `settings:${view.section ?? ''}`;
    default:
      return view.kind;
  }
}
