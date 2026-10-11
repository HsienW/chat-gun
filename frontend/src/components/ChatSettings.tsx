import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { Settings, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { IdentityLifecyclePanel } from '@/components/IdentityLifecyclePanel';
import { SubjectRightsPanel } from '@/components/SubjectRightsPanel';

const LABELS = { title: 'Setting', close: '關閉設定' } as const;

export function ChatSettings(props: ComponentProps<typeof IdentityLifecyclePanel>) {
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="fixed bottom-4 left-4 z-50">
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        className="gap-2 border-border bg-card text-foreground hover:bg-accent"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popupId}
        onClick={() => setOpen((current) => !current)}
      >
        <Settings aria-hidden="true" />
        {LABELS.title}
      </Button>
      <div
        id={popupId}
        role="dialog"
        aria-labelledby={titleId}
        hidden={!open}
        className="absolute bottom-full left-0 mb-3 max-h-[calc(100dvh-6rem)] w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg sm:bottom-0 sm:left-full sm:mb-0 sm:ml-3 sm:max-h-[calc(100dvh-2rem)] sm:w-[18vw] sm:min-w-80"
      >
        <div className="mb-1 flex items-center justify-between border-b border-border px-3 pb-2 pt-1">
          <h2 id={titleId} className="text-sm font-medium">{LABELS.title}</h2>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={LABELS.close}
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <IdentityLifecyclePanel {...props} />
        <SubjectRightsPanel />
      </div>
    </div>
  );
}
