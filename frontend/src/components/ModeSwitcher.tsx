import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { ENTRY_DEFINITIONS, getEntryDefinition, type EntryId } from '@/lib/entries';

const LABELS = {
  trigger: '切換模式',
  lockedHint: '回覆進行中或審批送出中無法切換模式，請先取消',
} as const;

interface ModeSwitcherProps {
  current: EntryId;
  locked: boolean;
  onSelect: (entry: EntryId) => void;
}

/** The current mode and its menu; choosing the current mode changes nothing. */
export function ModeSwitcher({ current, locked, onSelect }: ModeSwitcherProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const hintId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentEntry = getEntryDefinition(current);

  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);

  useEffect(() => {
    if (!open) return;
    const currentIndex = ENTRY_DEFINITIONS.findIndex((entry) => entry.id === current);
    itemRefs.current[currentIndex]?.focus();

    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
      const index = items.findIndex((item) => item === document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    };

    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [current, open]);

  const choose = (entry: EntryId) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (entry !== current) onSelect(entry);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${LABELS.trigger}，目前為 ${currentEntry.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={locked ? hintId : undefined}
        disabled={locked}
        title={locked ? LABELS.lockedHint : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-lg font-semibold text-[#F8F1E7] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
      >
        {currentEntry.name}
        <ChevronDown className="h-4 w-4 text-[#E7D9C1]/70" aria-hidden="true" />
      </button>
      {locked && (
        <span id={hintId} className="sr-only">
          {LABELS.lockedHint}
        </span>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={LABELS.trigger}
          className="absolute left-0 top-full mt-2 flex w-64 flex-col gap-1.5 rounded-xl border border-border bg-card p-1.5 shadow-2xl"
        >
          {ENTRY_DEFINITIONS.map((entry, index) => {
            const selected = entry.id === current;
            return (
              <button
                key={entry.id}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => choose(entry.id)}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none cursor-pointer"
              >
                <span className="flex flex-col">
                  <span className="font-semibold text-[#F8F1E7]">{entry.name}</span>
                  <span className="text-xs text-[#E7D9C1]/60">{entry.subtitle}</span>
                </span>
                {selected && <Check className="h-4 w-4 text-[#F8F1E7]" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
