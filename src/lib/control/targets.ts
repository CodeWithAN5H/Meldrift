import type { ControlTarget } from './desktop';

/**
 * Keeps the chosen control target only while it still exists. A window that
 * closed (or a fresh window with the same title) must not leave the panel
 * pointing at an id the native side can no longer arm.
 */
export function chooseTargetId(
  targets: ControlTarget[],
  currentId: string,
  captureLabel: string,
): string {
  if (currentId && targets.some((target) => target.id === currentId)) return currentId;
  const label = captureLabel.toLowerCase();
  if (label) {
    const matching = targets.find((target) => label.includes(target.title.toLowerCase()));
    if (matching) return matching.id;
  }
  return targets.find((target) => !target.minimized)?.id ?? '';
}
