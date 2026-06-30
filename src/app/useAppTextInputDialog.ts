// Author: Liz
import { useRef, useState } from "react";

interface TextInputDialogRequest {
  id: number;
  title: string;
  label: string;
  initialValue?: string;
  requiredMessage: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

type TextInputDialogOptions = Omit<TextInputDialogRequest, "id" | "resolve">;

export function useAppTextInputDialog() {
  const dialogRequestIdRef = useRef(0);
  const [textInputDialog, setTextInputDialog] = useState<TextInputDialogRequest | null>(null);

  function requestTextInput(options: TextInputDialogOptions): Promise<string | null> {
    return new Promise((resolve) => {
      dialogRequestIdRef.current += 1;
      setTextInputDialog({
        ...options,
        id: dialogRequestIdRef.current,
        resolve,
      });
    });
  }

  function resolveTextInputDialog(value: string | null) {
    const dialog = textInputDialog;
    if (!dialog) return;
    dialog.resolve(value);
    setTextInputDialog(null);
  }

  return {
    textInputDialog,
    requestTextInput,
    resolveTextInputDialog,
  };
}
