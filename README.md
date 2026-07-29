# worker-cms-plugin-credits

Optional credit and diamond support for 0xCMS Worker plugins.

This package decorates any CMS client implementing the small `request()`
transport contract. It has no runtime or peer dependency on
`@lionrockjs/worker-cms-plugin`, so the base client and this feature package can
be upgraded independently.

```sh
npm install @lionrockjs/worker-cms-plugin @lionrockjs/worker-cms-plugin-credits
```

```ts
import { CmsClient } from '@lionrockjs/worker-cms-plugin';
import { creditShortfall, withCredits } from '@lionrockjs/worker-cms-plugin-credits';

const cms = withCredits(new CmsClient(env, 'messaging'));

// Base methods are preserved by the decorator.
const message = await cms.create({
  page_type: 'message',
  name: 'Delivery',
});

// Credit methods are added by this package.
const quote = await cms.creditQuote('send_sms', recipients.length, userId);
if (!quote.affordable) return outOfBalance(quote.currency);

try {
  await cms.chargeCredits('send_sms', recipients.length, {
    actingUserId: userId,
    entityType: 'message',
    entityId: message.id,
  });
} catch (error) {
  const shortfall = creditShortfall(error);
  if (shortfall) return topUpPrompt(shortfall.currency);
  throw error;
}
```

`withCredits()` returns a non-mutating proxy: base methods still execute on the
wrapped client, while the four credit methods execute on a `CmsCredits`
decorator. Code that prefers explicit composition can use
`const credits = new CmsCredits(cms)` instead.

The official `@lionrockjs/worker-cms-plugin` client needs version `0.3.3` or
newer because that release introduces the stable `request()` transport. This
package does not declare or pin it, so later base-client releases do not require
a corresponding credits-package release.

## Manifest costs

The CMS meters chargeable actions in two independent currencies. `credit` is
the ordinary wallet; `diamond` is the premium wallet for actions for which the
operator pays real money, such as SMS and WhatsApp delivery. The wallets never
convert into each other.

A cost chooses its wallet in the plugin manifest. Omitting `currency` means
ordinary credits.

```json
{
  "credits": [
    {
      "key": "send_sms",
      "label": "Send SMS",
      "charge": "metered",
      "unit": "message",
      "currency": "diamond",
      "default": 3
    },
    {
      "key": "send_edm",
      "label": "Send EDM",
      "charge": "metered",
      "unit": "recipient",
      "default": 2
    }
  ]
}
```

The host owns pricing and charging. A plugin may request a quote or charge a
manifest-declared cost, but it cannot set a price or write a balance.

## API

- `credits(actingUserId?)` returns this plugin's declared costs and balances.
- `creditQuote(key, quantity, actingUserId?)` checks affordability without
  deducting anything.
- `chargeCredits(key, quantity, options?)` charges a `metered` cost.
- `reportCreditUsage(key, quantity, userId)` reports current usage for a
  `recurring` cost; the host bills it during its recurring sweep.
- `creditShortfall(error)` extracts the wallet and required balances from an
  `insufficient_credits` HTTP 402 response.

`balance` and `shared_balance` remain aliases for the ordinary credit wallet.
`balances` and `shared_balances` expose every wallet by currency.

## Host requirement

These methods call `/__cms/credits`, `/__cms/credits/quote`,
`/__cms/credits/charge`, and `/__cms/credits/usage`. A Worker CMS deployment
without the `credits` feature returns 404 for those routes. Base page and tenant
functionality remains on the independently installed base client.
