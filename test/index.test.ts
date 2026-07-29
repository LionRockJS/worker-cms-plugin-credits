import { describe, expect, it } from 'vitest';
import {
  CmsCredits,
  creditShortfall,
  withCredits,
  type CmsRequestMethod,
  type CmsRequestOptions,
} from '../src/index';

interface Call {
  method: CmsRequestMethod;
  path: string;
  options?: CmsRequestOptions;
}

function client(
  handler: (call: Call) => unknown | Promise<unknown>,
) {
  const calls: Call[] = [];
  const base = {
    marker: 'base-client',
    async request<T>(
      method: CmsRequestMethod,
      path: string,
      options?: CmsRequestOptions,
    ): Promise<T> {
      const call = { method, path, options };
      calls.push(call);
      return await handler(call) as T;
    },
    identify() {
      return this.marker;
    },
  };
  return { base, cms: withCredits(base), calls };
}

describe('credits decorator', () => {
  it('adds credit methods without mutating or replacing base behavior', async () => {
    const { base, cms } = client(() => ({ balance: null, shared_balance: 0, credits: [] }));

    expect(cms).not.toBe(base);
    expect('credits' in cms).toBe(true);
    expect('credits' in base).toBe(false);
    expect(cms.identify()).toBe('base-client');
    await expect(cms.credits()).resolves.toMatchObject({ credits: [] });
  });

  it('also supports an explicit standalone decorator object', async () => {
    const { base } = client(() => ({ key: 'send_sms', total: 3 }));
    const credits = new CmsCredits(base);

    await expect(credits.creditQuote('send_sms')).resolves.toMatchObject({
      key: 'send_sms',
      total: 3,
    });
  });

  it('reads balances and forwards acting-user attribution', async () => {
    const { cms, calls } = client(() => ({
      balance: 42,
      shared_balance: 0,
      balances: { credit: 42, diamond: 7 },
      shared_balances: { credit: 0, diamond: 9 },
      credits: [{ key: 'send_sms', currency: 'diamond', value: 3 }],
    }));

    const info = await cms.credits(501);

    expect(info.balances).toEqual({ credit: 42, diamond: 7 });
    expect(info.credits[0].currency).toBe('diamond');
    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/credits',
      options: { actingUserId: 501 },
    });
  });

  it('quotes and charges a metered cost in its declared currency', async () => {
    const { cms, calls } = client(({ path }) => (
      path.startsWith('/credits/quote')
        ? {
            key: 'send_sms',
            currency: 'diamond',
            unit_cost: 3,
            quantity: 2,
            total: 6,
            balance: 6,
            shared_balance: 0,
            affordable: true,
          }
        : {
            ok: true,
            charged: 6,
            currency: 'diamond',
            balance: 0,
            source: 'user',
          }
    ));

    await expect(cms.creditQuote('send_sms', 2, 501)).resolves.toMatchObject({
      currency: 'diamond',
      total: 6,
    });
    await expect(cms.chargeCredits('send_sms', 2, {
      actingUserId: 501,
      entityId: 9,
    })).resolves.toMatchObject({
      ok: true,
      charged: 6,
      currency: 'diamond',
    });

    expect(calls[0]).toEqual({
      method: 'GET',
      path: '/credits/quote?key=send_sms&quantity=2',
      options: { actingUserId: 501 },
    });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/credits/charge',
      options: {
        actingUserId: 501,
        body: {
          key: 'send_sms',
          quantity: 2,
          entity_type: undefined,
          entity_id: 9,
          note: undefined,
        },
      },
    });
  });

  it('extracts a wallet shortfall without importing the base error class', () => {
    const error = {
      status: 402,
      detail: {
        error: 'insufficient_credits',
        credit: {
          currency: 'diamond',
          required: 20,
          balance: 5,
          shared_balance: 0,
        },
      },
    };

    expect(creditShortfall(error)).toEqual({
      currency: 'diamond',
      required: 20,
      balance: 5,
      shared_balance: 0,
    });
    expect(creditShortfall({ ...error, status: 400 })).toBeNull();
    expect(creditShortfall(new Error('boom'))).toBeNull();
  });

  it('reports recurring usage without charging immediately', async () => {
    const { cms, calls } = client(() => ({
      ok: true,
      currency: 'diamond',
      subscription: { quantity: 2 },
    }));

    await expect(
      cms.reportCreditUsage('sms_number', 2, 501),
    ).resolves.toMatchObject({
      ok: true,
      currency: 'diamond',
    });

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/credits/usage',
      options: {
        actingUserId: 501,
        body: {
          key: 'sms_number',
          quantity: 2,
          user_id: 501,
        },
      },
    });
  });
});
