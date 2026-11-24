import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react';

/* --------------------------------------------------------------------------
   Fixed-height windowing for long collections (member lists, friend lists,
   message history). Rows are absolutely positioned inside a sized spacer so
   the scrollbar behaves natively and the DOM stays small.
   -------------------------------------------------------------------------- */

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  gap?: number;
  overscan?: number;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
  keyOf: (item: T, index: number) => string;
  empty?: ReactNode;
}

export function VirtualList<T>({
  items,
  itemHeight,
  gap = 0,
  overscan = 6,
  className,
  renderItem,
  keyOf,
  empty,
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  if (items.length === 0) {
    return <div className={className}>{empty}</div>;
  }

  const rowSpan = itemHeight + gap;
  const total = items.length * rowSpan - gap;
  const visibleCount = Math.ceil(viewportHeight / rowSpan) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowSpan) - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount);

  const rows: ReactNode[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = items[index];
    rows.push(
      <div
        key={keyOf(item, index)}
        className="md-vrow"
        style={{
          position: 'absolute',
          top: index * rowSpan,
          left: 0,
          right: 0,
          height: itemHeight,
        }}
      >
        {renderItem(item, index)}
      </div>,
    );
  }

  return (
    <div
      className={className}
      ref={viewportRef}
      onScroll={onScroll}
      style={{ overflowY: 'auto', height: '100%' }}
    >
      <div style={{ position: 'relative', height: total }}>{rows}</div>
    </div>
  );
}
