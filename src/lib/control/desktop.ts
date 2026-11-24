import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '@/lib/ipc';
import type { InputFrame } from './input';

/* --------------------------------------------------------------------------
   Typed bridge to the Rust input layer.

   Only the desktop build can inject input. In the browser preview `available`
   is false and the UI explains that remote control needs the Windows app
   instead of pretending it works.
   -------------------------------------------------------------------------- */

export interface ControlTarget {
  id: string;
  title: string;
  process: string;
  minimized: boolean;
}

export interface ArmedTarget {
  id: string;
  title: string;
  process: string;
  paused: boolean;
}

export const controlDesktop = {
  available: (): boolean => isTauri(),

  targets: (): Promise<ControlTarget[]> => invoke<ControlTarget[]>('control_targets'),

  arm: (id: string): Promise<ArmedTarget> => invoke<ArmedTarget>('control_arm', { id }),

  resume: (): Promise<ArmedTarget> => invoke<ArmedTarget>('control_resume'),

  end: (): Promise<void> => invoke<void>('control_end'),

  armed: (): Promise<ArmedTarget | null> => invoke<ArmedTarget | null>('control_armed'),

  inject: (frame: InputFrame): Promise<void> =>
    invoke<void>('control_inject', {
      batch: {
        keys: frame.keys,
        moves: frame.moves,
        buttons: frame.buttons,
        wheel: frame.wheel,
      },
    }),

  onPaused: (handler: (reason: string) => void): Promise<UnlistenFn> =>
    listen<string>('control://paused', (event) => handler(event.payload)),

  onInvalidated: (handler: (reason: string) => void): Promise<UnlistenFn> =>
    listen<string>('control://invalidated', (event) => handler(event.payload)),

  onEmergency: (handler: () => void): Promise<UnlistenFn> =>
    listen<string>('control://emergency', () => handler()),
};
