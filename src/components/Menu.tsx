import { useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useDismiss } from '@/lib/model';
import { IconButton, cx } from './ui';
import './menu.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function Menu({
  items,
  label = 'More actions',
  trigger,
  align = 'end',
}: {
  items: MenuItem[];
  label?: string;
  trigger?: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const { ref } = useDismiss(open, () => setOpen(false));

  return (
    <div className="md-menu" ref={ref}>
      {trigger ? (
        <button
          type="button"
          className="md-menu__trigger"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {trigger}
        </button>
      ) : (
        <IconButton
          label={label}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={17} />
        </IconButton>
      )}

      {open ? (
        <div className={cx('md-menu__pop', align === 'start' && 'md-menu__pop--start')} role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="md-menu__item"
              data-danger={item.danger}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
