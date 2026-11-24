/* --------------------------------------------------------------------------
   Physical key mapping.

   The controller sends the physical key, not the character it typed. DOM
   `KeyboardEvent.code` names a physical position (KeyW, ShiftLeft, ArrowUp…),
   which maps to a Windows set-1 scan code and a virtual-key code:

   - the scan code is what games using raw input/DirectInput read, so W stays
     the W key regardless of the host's keyboard layout;
   - the virtual key lets ordinary Windows applications translate the key into
     a character using the host's own layout.

   Codes that cannot be forwarded safely (the Windows key, Alt+Tab, Alt+F4,
   Ctrl+Shift+Esc, F11/F12) are blocked in `isBlockedCombination`, so a remote
   player cannot use the host's shell shortcuts to escape the game.
   -------------------------------------------------------------------------- */

export interface KeyStroke {
  /** Windows set-1 scan code. */
  scan: number;
  /** Windows virtual-key code. */
  vk: number;
  extended: boolean;
}

function key(scan: number, vk: number, extended = false): KeyStroke {
  return { scan, vk, extended };
}

export const CONTROL_KEY_MAP: Readonly<Record<string, KeyStroke>> = {
  Escape: key(0x01, 0x1b),
  Digit1: key(0x02, 0x31),
  Digit2: key(0x03, 0x32),
  Digit3: key(0x04, 0x33),
  Digit4: key(0x05, 0x34),
  Digit5: key(0x06, 0x35),
  Digit6: key(0x07, 0x36),
  Digit7: key(0x08, 0x37),
  Digit8: key(0x09, 0x38),
  Digit9: key(0x0a, 0x39),
  Digit0: key(0x0b, 0x30),
  Minus: key(0x0c, 0xbd),
  Equal: key(0x0d, 0xbb),
  Backspace: key(0x0e, 0x08),
  Tab: key(0x0f, 0x09),
  KeyQ: key(0x10, 0x51),
  KeyW: key(0x11, 0x57),
  KeyE: key(0x12, 0x45),
  KeyR: key(0x13, 0x52),
  KeyT: key(0x14, 0x54),
  KeyY: key(0x15, 0x59),
  KeyU: key(0x16, 0x55),
  KeyI: key(0x17, 0x49),
  KeyO: key(0x18, 0x4f),
  KeyP: key(0x19, 0x50),
  BracketLeft: key(0x1a, 0xdb),
  BracketRight: key(0x1b, 0xdd),
  Enter: key(0x1c, 0x0d),
  ControlLeft: key(0x1d, 0xa2),
  KeyA: key(0x1e, 0x41),
  KeyS: key(0x1f, 0x53),
  KeyD: key(0x20, 0x44),
  KeyF: key(0x21, 0x46),
  KeyG: key(0x22, 0x47),
  KeyH: key(0x23, 0x48),
  KeyJ: key(0x24, 0x4a),
  KeyK: key(0x25, 0x4b),
  KeyL: key(0x26, 0x4c),
  Semicolon: key(0x27, 0xba),
  Quote: key(0x28, 0xde),
  Backquote: key(0x29, 0xc0),
  ShiftLeft: key(0x2a, 0xa0),
  Backslash: key(0x2b, 0xdc),
  KeyZ: key(0x2c, 0x5a),
  KeyX: key(0x2d, 0x58),
  KeyC: key(0x2e, 0x43),
  KeyV: key(0x2f, 0x56),
  KeyB: key(0x30, 0x42),
  KeyN: key(0x31, 0x4e),
  KeyM: key(0x32, 0x4d),
  Comma: key(0x33, 0xbc),
  Period: key(0x34, 0xbe),
  Slash: key(0x35, 0xbf),
  ShiftRight: key(0x36, 0xa1),
  NumpadMultiply: key(0x37, 0x6a),
  AltLeft: key(0x38, 0xa4),
  Space: key(0x39, 0x20),
  CapsLock: key(0x3a, 0x14),
  F1: key(0x3b, 0x70),
  F2: key(0x3c, 0x71),
  F3: key(0x3d, 0x72),
  F4: key(0x3e, 0x73),
  F5: key(0x3f, 0x74),
  F6: key(0x40, 0x75),
  F7: key(0x41, 0x76),
  F8: key(0x42, 0x77),
  F9: key(0x43, 0x78),
  F10: key(0x44, 0x79),
  NumLock: key(0x45, 0x90),
  ScrollLock: key(0x46, 0x91),
  Numpad7: key(0x47, 0x67),
  Numpad8: key(0x48, 0x68),
  Numpad9: key(0x49, 0x69),
  NumpadSubtract: key(0x4a, 0x6d),
  Numpad4: key(0x4b, 0x64),
  Numpad5: key(0x4c, 0x65),
  Numpad6: key(0x4d, 0x66),
  NumpadAdd: key(0x4e, 0x6b),
  Numpad1: key(0x4f, 0x61),
  Numpad2: key(0x50, 0x62),
  Numpad3: key(0x51, 0x63),
  Numpad0: key(0x52, 0x60),
  NumpadDecimal: key(0x53, 0x6e),
  IntlBackslash: key(0x56, 0xe2),
  F11: key(0x57, 0x7a),
  F12: key(0x58, 0x7b),
  NumpadEnter: key(0x1c, 0x0d, true),
  ControlRight: key(0x1d, 0xa3, true),
  NumpadDivide: key(0x35, 0x6f, true),
  PrintScreen: key(0x37, 0x2c, true),
  AltRight: key(0x38, 0xa5, true),
  Home: key(0x47, 0x24, true),
  ArrowUp: key(0x48, 0x26, true),
  PageUp: key(0x49, 0x21, true),
  ArrowLeft: key(0x4b, 0x25, true),
  ArrowRight: key(0x4d, 0x27, true),
  End: key(0x4f, 0x23, true),
  ArrowDown: key(0x50, 0x28, true),
  PageDown: key(0x51, 0x22, true),
  Insert: key(0x52, 0x2d, true),
  Delete: key(0x53, 0x2e, true),
  ContextMenu: key(0x5d, 0x5d, true),
};

/** Keys that would escape the game or reach the host's shell. */
const BLOCKED_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'F11',
  'F12',
  'PrintScreen',
]);

export function isBlockedCombination(input: {
  code: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  if (BLOCKED_CODES.has(input.code)) return true;
  if (input.altKey && (input.code === 'Tab' || input.code === 'F4')) return true;
  if (input.ctrlKey && input.shiftKey && input.code === 'Escape') return true;
  return false;
}

export function keyStrokeFor(code: string): KeyStroke | null {
  return CONTROL_KEY_MAP[code] ?? null;
}
