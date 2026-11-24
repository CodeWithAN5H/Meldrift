import { useEffect, useRef } from 'react';
import { voiceEngine } from '@/lib/voice';

/**
 * Writes the analyser level straight to a CSS custom property, so a 60fps
 * meter never triggers a React render or a layout thrash elsewhere.
 */
export function MicLevel({ passive = false }: { passive?: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (passive) return;
    return voiceEngine.subscribe((level) => {
      const node = ref.current;
      if (!node) return;
      const value = Math.max(2, Math.round(level * 100));
      node.style.setProperty('--level', `${value}%`);
    });
  }, [passive]);

  return (
    <span className="md-miclevel" ref={ref} aria-hidden="true">
      <span className="md-miclevel__fill" />
    </span>
  );
}
