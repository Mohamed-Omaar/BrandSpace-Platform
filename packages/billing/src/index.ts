/**
 * Payment provider abstraction, subscriptions, invoices, credits commerce —
 * docs/BILLING-AND-CREDITS.md.
 *
 * PHASE 9. The domain model is OURS; a payment provider is a replaceable
 * adapter that moves money and holds the PCI scope. Nothing in this package
 * names a production provider: D-204 leaves that choice to the owner, and the
 * only adapter shipped here is the deterministic development one.
 */
export * from './commerce';
export * from './adapter';
export * from './adapters/development';
export * from './tax';
export * from './dunning';
export * from './checkout';
export * from './invoices';
export * from './credit-notes';
export * from './reconcile';
export * from './credits-port';
export * from './subscriptions';
