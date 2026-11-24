import { useEffect, useRef, useState } from 'react';
import { Gamepad2, MousePointer2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui';
import { useControlRoom } from '@/state/controlRoom';

/* --------------------------------------------------------------------------
   The controller's capture surface.

   Keyboard events are taken only while remote control is active and the game
   picture has focus. Relative mouse movement needs pointer lock; entering it is
   an explicit click, and Escape both exits pointer lock and releases control.
   On blur, tab hide or unmount every held key/button is released before the
   data channel closes.
   -------------------------------------------------------------------------- */

export function ControlSurface({
  stream,
  label,
}: {
  stream: MediaStream;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const local = useControlRoom((state) => state.local);
  const heldCount = useControlRoom((state) => state.heldCount);
  const latency = useControlRoom((state) => state.latencyMs);
  const pressKey = useControlRoom((state) => state.pressKey);
  const releaseKey = useControlRoom((state) => state.releaseKey);
  const moveMouse = useControlRoom((state) => state.moveMouse);
  const pressMouse = useControlRoom((state) => state.pressMouse);
  const scroll = useControlRoom((state) => state.scroll);
  const release = useControlRoom((state) => state.release);
  const stopControlling = useControlRoom((state) => state.stopControlling);
  const [locked, setLocked] = useState(false);
  const [focused, setFocused] = useState(false);

  const active = local === 'active';
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    return () => {
      if (useControlRoom.getState().local === 'active') {
        useControlRoom.getState().stopControlling();
      }
    };
  }, []);

  useEffect(() => {
    const onPointerLock = () => {
      const lockedNow = document.pointerLockElement === surfaceRef.current;
      setLocked(lockedNow);
      // Escape releases pointer lock; treat that as letting go of control.
      if (!lockedNow && useControlRoom.getState().local === 'active') {
        stopControlling();
      }
    };
    document.addEventListener('pointerlockchange', onPointerLock);
    return () => document.removeEventListener('pointerlockchange', onPointerLock);
  }, [stopControlling]);

  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    // Keyboard input follows the surface without requiring pointer lock; the
    // player only has to click once to capture the mouse.
    surface.focus();
    setFocused(true);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      // Never steal keys from an input inside the app.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!locked && document.activeElement !== surface && !surface.contains(document.activeElement)) {
        return;
      }
      if (pressKey(event)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      releaseKey(event.code);
    };
    const fromHud = (event: Event) =>
      Boolean((event.target as HTMLElement | null)?.closest?.('.md-controlsurface__hud, .md-controlsurface__capture'));
    const onMove = (event: MouseEvent) => {
      if (!activeRef.current || !locked || fromHud(event)) return;
      moveMouse(event.movementX, event.movementY);
    };
    const onDown = (event: MouseEvent) => {
      if (!activeRef.current || fromHud(event)) return;
      pressMouse(event.button as 0 | 1 | 2, true);
      event.preventDefault();
    };
    const onUp = (event: MouseEvent) => {
      if (!activeRef.current || fromHud(event)) return;
      pressMouse(event.button as 0 | 1 | 2, false);
    };
    const onWheel = (event: WheelEvent) => {
      if (!activeRef.current || fromHud(event)) return;
      scroll(-event.deltaY);
      event.preventDefault();
    };
    // The browser's context menu would swallow the right-button release and
    // leave the button held on the host until teardown.
    const onContextMenu = (event: MouseEvent) => {
      if (!activeRef.current) return;
      event.preventDefault();
    };
    const onBlur = () => {
      setFocused(false);
      if (useControlRoom.getState().local === 'active') stopControlling();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (useControlRoom.getState().local === 'active') stopControlling();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, locked, pressKey, releaseKey, moveMouse, pressMouse, scroll, stopControlling]);

  const captureMouse = () => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.focus();
    setFocused(true);
    if (!locked) {
      try {
        const request = surface.requestPointerLock?.();
        if (request && typeof (request as Promise<void>).catch === 'function') {
          (request as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Pointer lock is optional; keyboard control still works.
      }
    }
  };

  const letGo = () => {
    try {
      document.exitPointerLock?.();
    } catch {
      // Not locked.
    }
    release();
  };

  return (
    <div
      className="md-controlsurface"
      ref={surfaceRef}
      tabIndex={0}
      role="application"
      aria-label={`Remote game control: ${label}`}
      data-locked={locked}
      data-focused={focused}
      onMouseDown={(event) => {
        setFocused(true);
        if (!locked) {
          event.preventDefault();
          captureMouse();
        }
      }}
    >
      <video ref={videoRef} className="md-stream__video" autoPlay muted playsInline />
      <span className="md-stream__srlabel">{label}</span>

      <div className="md-controlsurface__hud">
        <span className="md-controlsurface__live">
          <Gamepad2 size={12} /> You have control
          {latency !== null ? ` · ${latency} ms` : ''}
          {heldCount > 0 ? ` · ${heldCount} held` : ''}
        </span>
        <span className="md-controlsurface__hint">
          {locked ? (
            <>
              <ShieldAlert size={11} /> Esc releases control
            </>
          ) : (
            <>
              <MousePointer2 size={11} /> Click the game to capture the mouse
            </>
          )}
        </span>
        <Button size="sm" variant="danger" onClick={letGo}>
          Release
        </Button>
      </div>

      {!locked ? (
        <button type="button" className="md-controlsurface__capture" onClick={captureMouse}>
          <MousePointer2 size={16} />
          Click to capture your mouse. Keyboard input is already live; Esc releases control.
        </button>
      ) : null}
    </div>
  );
}

/** Shown to the host and spectators while someone is controlling. */
export function ControlIndicator({
  name,
  mine,
  paused,
}: {
  name: string;
  mine: boolean;
  paused: boolean;
}) {
  return (
    <span className="md-control__stagebadge" data-mine={mine} data-paused={paused}>
      <Gamepad2 size={11} />
      {mine ? (paused ? 'Control paused' : 'You have control') : `${name} is controlling`}
    </span>
  );
}
