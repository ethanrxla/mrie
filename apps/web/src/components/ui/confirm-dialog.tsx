"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect } from "react";

export interface ConfirmationRequest {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmationRequest | null; onClose: () => void }) {
  useEffect(() => {
    if (!request) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, request]);

  if (!request) return null;

  const confirm = async () => {
    await request.onConfirm();
    onClose();
  };

  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <button className="icon-button confirm-dialog__close" type="button" onClick={onClose} aria-label="Close confirmation"><X size={17} /></button>
        <span className={`confirm-dialog__icon confirm-dialog__icon--${request.tone ?? "default"}`}><AlertTriangle size={22} /></span>
        <h2 id="confirm-title">{request.title}</h2>
        <p id="confirm-description">{request.description}</p>
        <div className="confirm-dialog__actions">
          <button className="button button--secondary" type="button" onClick={onClose}>Cancel</button>
          <button className={request.tone === "danger" ? "button button--danger" : "button button--primary"} type="button" onClick={() => void confirm()} autoFocus>{request.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
