import { useId } from 'react';

/** The Meldrift mark: two gamepad grips forming a heart. */
export function MeldriftMark({ size = 26 }: { size?: number }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Meldrift"
      className="md-mark"
    >
      <defs>
        <linearGradient id={gradientId} x1="6" y1="4" x2="26" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#b79bff" />
          <stop offset="52%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <path
        d="M16 7.4c2.5-2.3 6.1-2.1 8.1.6 1.8 2.4 1.7 5.6.6 9.6l-1.5 5.4c-.5 1.7-2.7 2.2-3.9.9L16 20.1l-3.3 3.8c-1.2 1.3-3.4.8-3.9-.9l-1.5-5.4c-1.1-4-1.2-7.2.6-9.6 2-2.7 5.6-2.9 8.1-.6Z"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M16 11.6c.9-1.2 2.7-1.4 3.6-.2.6.8.6 1.9.1 3.2l-.4 1.4c-.3.9-1.4 1.1-2 .3l-1.3-1.6-1.3 1.6c-.6.8-1.7.6-2-.3l-.4-1.4c-.5-1.3-.5-2.4.1-3.2.9-1.2 2.7-1 3.6.2Z"
        fill="#0b0911"
        fillOpacity="0.55"
      />
      <circle cx="9.9" cy="11.6" r="1.05" fill="#0b0911" fillOpacity="0.5" />
      <circle cx="22.1" cy="11.6" r="1.05" fill="#0b0911" fillOpacity="0.5" />
    </svg>
  );
}
