import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      closeButton
      position="top-right"
      richColors
      toastOptions={{
        classNames: {
          toast: "toast",
          title: "toast-title",
          description: "toast-description",
          actionButton: "toast-action",
          cancelButton: "toast-cancel",
          closeButton: "toast-close"
        }
      }}
      {...props}
    />
  );
}

export { Toaster };
