/**
 * Synthetic after-sales policy and FAQ documents for the X42 knowledge corpus.
 * Every fact here is invented for evaluation; nothing describes a real business.
 */
export interface PolicyDocumentSeed {
  sourceId: string;
  sourceType: "policy" | "faq";
  title: string;
  body: string;
}

export const POLICY_DOCUMENTS: readonly PolicyDocumentSeed[] = [
  {
    sourceId: "policy-return-window",
    sourceType: "policy",
    title: "Return Window",
    body: `Most items can be returned within 30 days of the delivery date shown in your order history.

The return window starts on the day the carrier marks the parcel as delivered, not on the order date. If an order arrives in several parcels, each parcel has its own 30-day window.

Items must be returned in their original packaging with all accessories, manuals, and free gifts included. Items that show signs of use beyond normal inspection may receive a partial refund.

Members of the Plus program receive an extended 45-day return window on all eligible items.`,
  },
  {
    sourceId: "policy-final-sale",
    sourceType: "policy",
    title: "Final Sale Items",
    body: `Some items are sold as final sale and cannot be returned or exchanged. The product page and the order confirmation both label these items as "Final Sale".

Final sale applies to: clearance items marked down by 50% or more, opened personal-care products, gift cards, and custom-engraved products.

Final sale items that arrive damaged or defective are still covered by the Damaged or Defective Items policy and can be replaced.`,
  },
  {
    sourceId: "policy-refund-methods",
    sourceType: "policy",
    title: "Refund Methods",
    body: `Refunds are issued to the original payment method used for the order.

Card refunds appear on your statement within 5 to 10 business days after the return is approved. Digital wallet refunds usually arrive within 3 business days. Store credit refunds are applied instantly after approval.

If the original payment method is no longer available, the refund is issued as store credit. Store credit does not expire.

Orders paid partly with a gift card are refunded to the gift card first, then to the other payment method.`,
  },
  {
    sourceId: "policy-refund-timeline",
    sourceType: "policy",
    title: "Refund Processing Timeline",
    body: `After the warehouse receives a returned item, inspection takes up to 3 business days. Once the item passes inspection, the refund is approved and you receive an email confirmation.

The total time from drop-off to refund is typically 7 to 14 business days, depending on the carrier and your payment method.

You can follow the status of a refund in your order history. A refund shows the states Requested, In Transit, Received, Inspecting, Approved, and Refunded.`,
  },
  {
    sourceId: "policy-return-shipping-cost",
    sourceType: "policy",
    title: "Return Shipping Costs",
    body: `Return shipping is free for items that arrive damaged, defective, or different from what you ordered.

For all other returns, a flat return shipping fee of 6.95 USD is deducted from the refund. Plus members do not pay the return shipping fee.

If you return several items from the same order in one parcel, the fee is charged only once.`,
  },
  {
    sourceId: "policy-damaged-defective",
    sourceType: "policy",
    title: "Damaged or Defective Items",
    body: `If an item arrives damaged or stops working because of a manufacturing defect, report it within 14 days of delivery.

Attach at least one photo that shows the damage or the defect. You can choose a replacement or a full refund, including the original shipping cost.

For defects that appear after 14 days, the manufacturer warranty applies instead.`,
  },
  {
    sourceId: "policy-exchanges",
    sourceType: "policy",
    title: "Exchanges",
    body: `You can exchange an item for a different size or color of the same product within the return window.

Exchanges are shipped once the original item is scanned by the carrier. If the replacement costs more, you pay the difference; if it costs less, the difference is refunded to the original payment method.

Exchanges for a different product are not supported. Return the original item and place a new order instead.`,
  },
  {
    sourceId: "policy-order-cancellation",
    sourceType: "policy",
    title: "Order Cancellation",
    body: `You can cancel an order free of charge until it is packed. Orders usually move to packing within 2 hours of payment.

After an order is packed, it can no longer be cancelled. You can refuse the delivery or return the items under the Return Window policy.

Cancelled orders are refunded in full to the original payment method within 3 to 5 business days.`,
  },
  {
    sourceId: "policy-partial-cancellation",
    sourceType: "policy",
    title: "Partial Order Cancellation",
    body: `Individual items in an order can be cancelled before the order is packed. The shipping fee is recalculated for the remaining items.

If removing an item drops the order below the free-shipping threshold, the standard shipping fee is charged on the remaining items.`,
  },
  {
    sourceId: "policy-shipping-times",
    sourceType: "policy",
    title: "Shipping Times",
    body: `Standard shipping takes 3 to 7 business days within the United States and 5 to 12 business days within the European Union.

Express shipping takes 1 to 3 business days within the United States and 2 to 5 business days within the European Union.

Orders placed after 2 p.m. local warehouse time ship the next business day. Shipping times do not include weekends or public holidays.`,
  },
  {
    sourceId: "policy-shipping-fees",
    sourceType: "policy",
    title: "Shipping Fees",
    body: `Standard shipping is free for orders of 50 USD or more. Below that threshold, standard shipping costs 5.99 USD.

Express shipping costs 14.99 USD regardless of order value. Plus members receive free express shipping on all orders.`,
  },
  {
    sourceId: "policy-international-returns",
    sourceType: "policy",
    title: "International Returns",
    body: `Customers in the European Union, the United Kingdom, Canada, and Australia can return items through a local drop-off partner.

International returns follow the same 30-day window. The return shipping fee for international returns is 12.95 USD, and it is waived for damaged or defective items.

Import duties paid on the original order are refunded only when the full order is returned.`,
  },
  {
    sourceId: "policy-shipping-regions",
    sourceType: "policy",
    title: "Shipping Regions",
    body: `We ship to the United States, Canada, the United Kingdom, the European Union, Australia, and New Zealand.

We do not currently ship to P.O. boxes outside the United States or to military addresses outside the United States.`,
  },
  {
    sourceId: "policy-warranty",
    sourceType: "policy",
    title: "Manufacturer Warranty",
    body: `Electronics carry a manufacturer warranty of 12 months from the delivery date unless the product page states a longer period.

The warranty covers manufacturing defects. It does not cover accidental damage, water damage on non-waterproof products, or normal wear of batteries and cushions.

To make a warranty claim, contact support with your order number and a description of the problem. Warranty repairs or replacements are shipped free of charge.`,
  },
  {
    sourceId: "policy-extended-protection",
    sourceType: "policy",
    title: "Extended Protection Plans",
    body: `Extended protection plans can be added to eligible electronics at checkout or within 30 days of delivery.

A plan extends coverage to 36 months and adds one accidental-damage claim per year. Plans can be cancelled within 30 days for a full refund, and after that for a prorated refund.`,
  },
  {
    sourceId: "policy-price-adjustment",
    sourceType: "policy",
    title: "Price Adjustment",
    body: `If the price of an item drops within 14 days of delivery, you can request a one-time price adjustment for the difference.

Price adjustments do not apply to clearance events, flash sales that last less than 24 hours, or prices offered by other retailers.`,
  },
  {
    sourceId: "policy-gift-returns",
    sourceType: "policy",
    title: "Returning a Gift",
    body: `Gift recipients can return an item with the gift receipt or the order number. The refund is issued as store credit to the recipient, and the buyer is not notified.

Gift returns follow the same 30-day window, counted from the delivery date.`,
  },
  {
    sourceId: "policy-plus-membership",
    sourceType: "policy",
    title: "Plus Membership Benefits",
    body: `Plus membership costs 49 USD per year. Benefits include free express shipping, free return shipping, and a 45-day return window.

Membership can be cancelled at any time. If you cancel within 14 days and have not used any benefit, the fee is refunded in full.`,
  },
  {
    sourceId: "policy-payment-methods",
    sourceType: "policy",
    title: "Accepted Payment Methods",
    body: `We accept major credit and debit cards, two digital wallets, store credit, and gift cards.

Cash on delivery is not available. Orders above 2,000 USD may require additional verification before they are packed.`,
  },
  {
    sourceId: "policy-refund-request-steps",
    sourceType: "policy",
    title: "How to Request a Refund",
    body: `To request a refund, open the order in your order history and choose "Request a return" next to the item.

Select a reason, choose the refund method if more than one is available, and confirm. You receive a prepaid label or a drop-off code by email.

A refund request can be withdrawn until the item is scanned by the carrier.`,
  },
  {
    sourceId: "faq-where-is-my-refund",
    sourceType: "faq",
    title: "FAQ: Where is my refund?",
    body: `Q: My return was delivered but I have not received my refund.

A: Inspection takes up to 3 business days after the warehouse receives the item. After approval, card refunds take 5 to 10 business days to appear. If more than 14 business days have passed since delivery to the warehouse, contact support with your order number.`,
  },
  {
    sourceId: "faq-missing-item",
    sourceType: "faq",
    title: "FAQ: An item is missing from my parcel",
    body: `Q: My parcel arrived but one item is missing.

A: Check whether the order was split into several parcels in your order history. If the item was not shipped separately, report the missing item within 7 days of delivery and we will reship it or refund it.`,
  },
  {
    sourceId: "faq-change-address",
    sourceType: "faq",
    title: "FAQ: Can I change my delivery address?",
    body: `Q: Can I change the delivery address after placing an order?

A: You can change the address until the order is packed. After packing, the address can no longer be changed, but you can ask the carrier to redirect the parcel where the carrier supports it.`,
  },
  {
    sourceId: "faq-wrong-item",
    sourceType: "faq",
    title: "FAQ: I received the wrong item",
    body: `Q: The item I received is not the one I ordered.

A: Report it within 14 days of delivery. Return shipping is free, and we ship the correct item as soon as the carrier scans the return.`,
  },
  {
    sourceId: "faq-size-guide",
    sourceType: "faq",
    title: "FAQ: How do I choose the right shoe size?",
    body: `Q: How do I choose the right running shoe size?

A: Measure your foot length in the evening and use the size chart on the product page. If you are between sizes, choose the larger size. Running shoes can be exchanged for a different size within the return window.`,
  },
  {
    sourceId: "faq-battery-care",
    sourceType: "faq",
    title: "FAQ: How do I care for headphone batteries?",
    body: `Q: How can I keep my wireless headphone battery healthy?

A: Avoid leaving the headphones fully discharged for long periods and keep them away from heat. Battery wear over time is not covered by the warranty.`,
  },
  {
    sourceId: "faq-water-resistance",
    sourceType: "faq",
    title: "FAQ: Are smartwatches waterproof?",
    body: `Q: Can I swim with my smartwatch?

A: Only models rated 5 ATM or higher are suitable for swimming. Models rated IP67 or IP68 resist splashes and brief immersion but are not designed for swimming. Water damage on models used beyond their rating is not covered by the warranty.`,
  },
  {
    sourceId: "faq-order-tracking",
    sourceType: "faq",
    title: "FAQ: How do I track my order?",
    body: `Q: How can I track my order?

A: A tracking link is sent by email when the order ships and is also shown in your order history. Tracking can take up to 24 hours to update after shipping.`,
  },
  {
    sourceId: "faq-coffee-maker-descaling",
    sourceType: "faq",
    title: "FAQ: How often should I descale my coffee maker?",
    body: `Q: How often should I descale my coffee maker?

A: Descale every 2 to 3 months, or monthly if you have hard water. Damage caused by limescale buildup is not covered by the warranty.`,
  },
  {
    sourceId: "faq-store-credit",
    sourceType: "faq",
    title: "FAQ: How do I use store credit?",
    body: `Q: How do I use my store credit?

A: Store credit is applied automatically at checkout. It can be combined with a card payment but not with another gift card in the same order. Store credit does not expire.`,
  },
];
