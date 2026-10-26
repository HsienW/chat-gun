import type { ProductResultCard as ProductResultCardData } from '@/lib/commerce-cards';

export function ProductResultCard({ card }: { card: ProductResultCardData }) {
  return (
    <article
      data-testid={`product-${card.sourceId}`}
      className="border border-border bg-card/70 rounded-lg px-4 py-3 space-y-1"
    >
      <h3 className="text-sm font-medium text-foreground">
        {card.title}
        <span className="ml-2 text-xs text-muted-foreground">[{card.citationId}]</span>
      </h3>
      <p className="text-xs text-muted-foreground">{card.snippet}</p>
    </article>
  );
}
