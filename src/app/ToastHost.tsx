import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info } from 'lucide-react';
import { useUi } from '@/state/ui';

export function ToastHost() {
  const toasts = useUi((state) => state.toasts);
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="md-toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className="md-toast" data-tone={toast.tone}>
          {toast.tone === 'error' ? (
            <AlertTriangle size={14} />
          ) : toast.tone === 'success' ? (
            <Check size={14} />
          ) : (
            <Info size={14} />
          )}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
