import { useEffect, useId, useRef } from 'react';

import { Button } from '@/components/ui/button';

const LABELS = {
  title: '仍有待審批的操作',
  message: '待審批的操作不會帶到新對話；伺服器會依審批期限自行處理，這裡不會替你核准、拒絕或撤回。',
  confirm: '確認離開',
  cancel: '留在這裡',
} as const;

interface LeaveConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function LeaveConfirmDialog({ onConfirm, onCancel }: LeaveConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="w-full max-w-md rounded-2xl border border-[#7A1E1E]/60 bg-[#211612] p-5 text-left shadow-2xl"
      >
        <h2 id={titleId} className="text-base font-semibold text-[#F8F1E7]">
          {LABELS.title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-[#E7D9C1]">
          {LABELS.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            className="rounded-xl border-border bg-card text-[#E7D9C1] hover:bg-muted"
            onClick={onCancel}
          >
            {LABELS.cancel}
          </Button>
          <Button
            type="button"
            className="rounded-xl bg-[#7A1E1E] text-[#F8F1E7] hover:bg-[#9F3434]"
            onClick={onConfirm}
          >
            {LABELS.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
