/**
 * ToastContainer — Toast notification'ları ekranın sağ alt köşesinde stack olarak render eder.
 *
 * Pozisyon: fixed bottom-6 right-6
 * Z-index: z-[100] — Settings modal'ın (z-50) üstünde kalır
 * Stack: flex-col-reverse — en yeni toast altta (Discord/OS notification stili)
 * Max: 5 toast aynı anda (toastStore tarafında enforce edilir)
 *
 * Bu component AppLayout'a mount edilir — uygulama genelinde her zaman aktif.
 */

import { useToastStore } from "../../stores/toastStore";
import Toast from "./Toast";

function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[100] flex flex-col-reverse gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast
            id={toast.id}
            type={toast.type}
            message={toast.message}
            isExiting={toast.isExiting}
            onDismiss={removeToast}
          />
        </div>
      ))}
    </div>
  );
}

export default ToastContainer;
