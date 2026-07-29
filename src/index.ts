/**
 * Minimal structural contract required by the credits decorator.
 *
 * It intentionally duplicates the stable request shape from
 * @lionrockjs/worker-cms-plugin instead of importing that package. Any current
 * or future client implementing this contract can be decorated.
 */
export type CmsRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CmsRequestOptions {
  body?: unknown;
  actingUserId?: number | string;
}

export interface CmsCreditTransport {
  request<T>(
    method: CmsRequestMethod,
    path: string,
    options?: CmsRequestOptions,
  ): Promise<T>;
}

/**
 * Which wallet a cost is paid from. `credit` is the ordinary metered currency;
 * `diamond` is the premium one, for actions for which the operator pays real
 * money. The wallets never convert into each other.
 */
export type CmsCreditCurrency = 'credit' | 'diamond';

/** One cost declared in the calling plugin's manifest and priced host-side. */
export interface CmsCredit {
  key: string;
  label: string;
  description: string;
  charge: 'page_create' | 'metered' | 'recurring';
  /** Older CMS builds omit this field and implicitly use ordinary credits. */
  currency?: CmsCreditCurrency;
  page_type: string | null;
  unit: string;
  value: number;
  configured: boolean;
  /** Recurring only: usage block the price applies to, and when it bills. */
  per?: number;
  billing?: 'advance' | 'arrears';
}

/** This plugin's declared costs plus the acting user's balances. */
export interface CmsCreditsInfo {
  /** Ordinary credit balance retained for compatibility with older hosts. */
  balance: number | null;
  /** Ordinary shared credit balance retained for older hosts. */
  shared_balance: number;
  balances?: Record<CmsCreditCurrency, number> | null;
  shared_balances?: Record<CmsCreditCurrency, number>;
  credits: CmsCredit[];
}

/** An affordability answer for one cost, in that cost's own currency. */
export interface CmsCreditQuote {
  key: string;
  currency?: CmsCreditCurrency;
  unit_cost: number;
  quantity: number;
  total: number;
  balance: number | null;
  shared_balance: number;
  affordable: boolean;
}

/** What a metered charge took, and from which balance. */
export interface CmsCreditCharge {
  ok: true;
  charged: number;
  currency?: CmsCreditCurrency;
  balance: number | null;
  source?: 'user' | 'shared';
}

/** The credit block returned with an insufficient-balance HTTP 402. */
export interface CmsCreditShortfall {
  currency?: CmsCreditCurrency;
  required: number;
  balance: number;
  shared_balance: number;
}

export interface CmsCreditChargeOptions {
  actingUserId?: number | string;
  entityType?: string;
  entityId?: string | number;
  note?: string;
}

export interface CmsCreditMethods {
  credits(actingUserId?: number | string): Promise<CmsCreditsInfo>;
  creditQuote(
    key: string,
    quantity?: number,
    actingUserId?: number | string,
  ): Promise<CmsCreditQuote>;
  chargeCredits(
    key: string,
    quantity: number,
    options?: CmsCreditChargeOptions,
  ): Promise<CmsCreditCharge>;
  reportCreditUsage(
    key: string,
    quantity: number,
    userId: number | string,
  ): Promise<{ ok: true; currency?: CmsCreditCurrency; subscription: unknown }>;
}

/**
 * GoF-style feature decorator: it wraps any compatible CMS transport and adds
 * the optional credit operations without inheriting from a concrete client.
 */
export class CmsCredits implements CmsCreditMethods {
  constructor(private readonly transport: CmsCreditTransport) {}

  /** Returns this plugin's costs and the selected user's wallet balances. */
  async credits(actingUserId?: number | string): Promise<CmsCreditsInfo> {
    return this.transport.request('GET', '/credits', { actingUserId });
  }

  /** Checks affordability without deducting anything. */
  async creditQuote(
    key: string,
    quantity = 1,
    actingUserId?: number | string,
  ): Promise<CmsCreditQuote> {
    const params = new URLSearchParams({ key, quantity: String(quantity) });
    return this.transport.request('GET', `/credits/quote?${params}`, {
      actingUserId,
    });
  }

  /**
   * Charges a manifest-declared `metered` cost. An insufficient wallet throws
   * the transport's HTTP 402 error; use creditShortfall() to inspect it.
   */
  async chargeCredits(
    key: string,
    quantity: number,
    options: CmsCreditChargeOptions = {},
  ): Promise<CmsCreditCharge> {
    return this.transport.request('POST', '/credits/charge', {
      actingUserId: options.actingUserId,
      body: {
        key,
        quantity,
        entity_type: options.entityType,
        entity_id: options.entityId,
        note: options.note,
      },
    });
  }

  /**
   * Reports the current quantity for a recurring cost. The host's recurring
   * sweep performs billing; this request does not immediately charge.
   */
  async reportCreditUsage(
    key: string,
    quantity: number,
    userId: number | string,
  ): Promise<{ ok: true; currency?: CmsCreditCurrency; subscription: unknown }> {
    return this.transport.request('POST', '/credits/usage', {
      actingUserId: userId,
      body: { key, quantity, user_id: userId },
    });
  }
}

export type CmsClientWithCredits<T extends CmsCreditTransport> =
  T & CmsCreditMethods;

const CREDIT_METHODS = [
  'credits',
  'creditQuote',
  'chargeCredits',
  'reportCreditUsage',
] as const satisfies ReadonlyArray<keyof CmsCreditMethods>;

/**
 * Decorates a CMS client without mutating it. Base methods are delegated to
 * the wrapped client; credit methods are delegated to CmsCredits.
 */
export function withCredits<T extends CmsCreditTransport>(
  client: T,
): CmsClientWithCredits<T> {
  const credits = new CmsCredits(client);
  const creditKeys = new Set<PropertyKey>(CREDIT_METHODS);
  const bound = new Map<PropertyKey, unknown>();

  return new Proxy(client, {
    get(target, property) {
      if (bound.has(property)) return bound.get(property);

      const owner = creditKeys.has(property) ? credits : target;
      const value = Reflect.get(owner, property, owner);
      if (typeof value !== 'function') return value;

      const method = value.bind(owner);
      bound.set(property, method);
      return method;
    },
    has(target, property) {
      return creditKeys.has(property) || Reflect.has(target, property);
    },
  }) as CmsClientWithCredits<T>;
}

/** Returns the shortfall behind a credit endpoint's HTTP 402, otherwise null. */
export function creditShortfall(error: unknown): CmsCreditShortfall | null {
  if (!error || typeof error !== 'object') return null;
  const failure = error as { status?: unknown; detail?: unknown };
  if (failure.status !== 402 || !failure.detail || typeof failure.detail !== 'object') return null;

  const credit = (failure.detail as { credit?: unknown }).credit;
  if (!credit || typeof credit !== 'object') return null;
  if (typeof (credit as CmsCreditShortfall).required !== 'number') return null;
  return credit as CmsCreditShortfall;
}
