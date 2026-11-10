// Payment provider adapters: interface, built-in sandbox processor, Stripe adapter.
import type { Json } from '../contracts.ts';

export type ProviderStatus = 'processing' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
export type ProviderPayment = Readonly<{ providerRef: string; status: ProviderStatus; failureCode?: string; checkoutUrl?: string; clientSecret?: string }>;
export type ProviderEvent = Readonly<{ id: string; type: string; createdAt: string; providerRef: string; paymentId: string | null; status: ProviderStatus | null; failureCode?: string }>;
export type CreatePaymentRequest = Readonly<{ paymentId: string; amountMinor: number; currency: string; description: string; idempotencyKey: string; method?: string; metadata: Readonly<Record<string, string>>; returnUrl?: string }>;
/**
 * A payment processor. Implementations must send `idempotencyKey` to the provider on every mutating call so a retry can
 * never create a second charge, and must throw `PaymentOutcomeUnknown` when a request may or may not have been processed.
 */
export interface PaymentProvider {
  readonly name: string;
  /** `sandbox` = built-in simulator, `test` = a real provider's test mode, `live` = real money. */
  readonly mode: 'sandbox' | 'test' | 'live';
  createPayment(request: CreatePaymentRequest): Promise<ProviderPayment>;
  /** Current provider state by provider reference; null when the provider has no such payment. */
  fetchPayment(providerRef: string): Promise<ProviderPayment | null>;
  /** Recovers the provider's record for an attempt whose outcome is unknown, without ever creating a second charge. Null = provider has no record. */
  recover(request: CreatePaymentRequest): Promise<ProviderPayment | null>;
  /** Verifies signature and timestamp tolerance, then parses. Throws DomainError('invalid_signature'). */
  verifyWebhook(raw: Uint8Array, headers: Readonly<Record<string, string | string[] | undefined>>, now: Date, toleranceSeconds: number): ProviderEvent;
}
export class PaymentOutcomeUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'PaymentOutcomeUnknown'; }
}
export type { Json };
