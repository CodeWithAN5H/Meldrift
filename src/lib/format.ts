/** Time, text and size formatting shared across screens. */

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

export function clockTime(ts: number): string {
  return timeFormatter.format(new Date(ts));
}

export function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, today)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return dayFormatter.format(date);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Compact relative time: "now", "4m", "3h", "2d", then a date. */
export function relativeTime(ts: number, now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dayFormatter.format(new Date(ts));
}

export function memberCountLabel(count: number): string {
  return count === 1 ? '1 member' : `${count} members`;
}

/** 1080 -> "1080p", used in streaming quality rows. */
export function resolutionLabel(height: number): string {
  const map: Record<number, string> = {
    720: '720p',
    1080: '1080p',
    1440: '1440p',
    2160: '2160p',
  };
  return map[height] ?? `${height}p`;
}

export function compactPath(path: string, max = 42): string {
  if (path.length <= max) return path;
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? path;
  if (file.length >= max) return `…${file.slice(-(max - 1))}`;
  return `…\\${file}`;
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return 'Late night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
