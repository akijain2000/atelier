import { useEffect, useRef } from 'react';

const TYPE_CLASS = {
  info: 'toast-info',
  error: 'toast-error',
  success: 'toast-success',
};

export default function Toast({
  message,
  type = 'info',
  visible,
  onDismiss,
}) {
  const dismissTimerRef = useRef(null);

  useEffect(() => {
    if (!visible || !message) return undefined;

    dismissTimerRef.current = window.setTimeout(() => {
      onDismiss?.();
    }, 4000);

    return () => {
      if (dismissTimerRef.current != null) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [visible, message, onDismiss]);

  if (!message) return null;

  const typeClass = TYPE_CLASS[type] ?? TYPE_CLASS.info;

  return (
    <div
      className={`toast-container${visible ? '' : ' toast-hidden'}`}
      role="status"
      aria-live="polite"
      onClick={() => onDismiss?.()}
    >
      <div className={`toast ${typeClass}`}>{message}</div>
    </div>
  );
}
