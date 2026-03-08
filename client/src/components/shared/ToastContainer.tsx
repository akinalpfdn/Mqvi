/**
 * ToastContainer — Renders stacked toasts at bottom-right. Mounted in AppLayout.
 */

import { useToastStore } from "../../stores/toastStore";
import Toast from "./Toast";

function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          id={toast.id}
          type={toast.type}
          message={toast.message}
          isExiting={toast.isExiting}
          onDismiss={removeToast}
        />
      ))}
    </div>
  );
}

export default ToastContainer;
