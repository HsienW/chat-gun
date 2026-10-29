import {
  ENTRY_DEFINITIONS,
  HOMEPAGE_GREETING,
  HOMEPAGE_HINT,
  HOMEPAGE_TITLE,
  LOGO_SRC,
  type EntryId,
} from '@/lib/entries';

// Served from public/ under the Vite base, like the logo.
const ENTRY_ICON_SRC: Record<EntryId, string> = {
  gun_chat: `${import.meta.env.BASE_URL}ai-chat-icon.png`,
  gun_shop: `${import.meta.env.BASE_URL}ai-shop-icon.png`,
};

interface HomeScreenProps {
  onSelectEntry: (entry: EntryId) => void;
}

/** The homepage: the product title and one card per entry; it never starts a run. */
export function HomeScreen({ onSelectEntry }: HomeScreenProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-10 px-4 pt-6 text-center">
      <div className="flex flex-col items-center gap-6">
        <img
          src={LOGO_SRC}
          alt="Chat Logo"
          className="h-28 w-28 rounded-2xl border border-[#E7D9C1]/20 object-cover shadow-xl shadow-[#7A1E1E]/20"
        />
        <div>
          <h1 className="text-5xl md:text-6xl font-semibold text-[#F8F1E7] mb-3">
            {HOMEPAGE_TITLE}
          </h1>
          <p className="text-xl md:text-2xl text-[#E7D9C1]/80">{HOMEPAGE_GREETING}</p>
        </div>
      </div>
      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        {ENTRY_DEFINITIONS.map((entry) => {
          return (
            <button
              key={entry.id}
              type="button"
              aria-label={`${entry.name} ${entry.subtitle}`}
              onClick={() => onSelectEntry(entry.id)}
              className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card/90 p-5 text-center shadow-lg shadow-black/10 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            >
              <img
                src={ENTRY_ICON_SRC[entry.id]}
                alt=""
                aria-hidden="true"
                className="h-25 w-25 object-contain"
              />
              <span className="text-xl font-semibold text-[#F8F1E7]">{entry.name}</span>
              <span className="text-sm text-[#E7D9C1]/80">{entry.subtitle}</span>
              <ul className="mt-1 w-fit list-disc space-y-1 rounded-xl border border-border bg-background/40 py-3 pl-8 pr-4 text-left text-xs leading-relaxed whitespace-nowrap text-[#E7D9C1]/60 marker:text-[#E7D9C1]/60">
                {entry.highlights.map((highlight) => (
                  <li key={highlight}>{highlight}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-[#E7D9C1]/50">{HOMEPAGE_HINT}</p>
    </div>
  );
}
