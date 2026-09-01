# sui-x402 documentation

| Start here                  |                                                         |
| --------------------------- | ------------------------------------------------------- |
| [Overview](overview.md)     | What problem this solves, why this shape, who it is for |
| [Quickstart](quickstart.md) | A paid API in 10 lines and a paying agent in 5          |

| Understand                          |                                                                 |
| ----------------------------------- | --------------------------------------------------------------- |
| [Concepts](concepts.md)             | The payment lifecycle, headers, strict vs fast, expiry, retries |
| [Security model](security-model.md) | Trust boundaries and the defenses on each side                  |
| [Decisions](decisions.md)           | Design record D1–D16, review rounds, evidence                   |
| [Spec notes](spec-notes.md)         | Observed behaviour of the live facilitator vs the x402 spec     |

| Build                                         |                                                              |
| --------------------------------------------- | ------------------------------------------------------------ |
| [Guide: sell](guides/sell.md)                 | Hono, Express and Next.js adapters, configuration, responses |
| [Guide: pay](guides/pay.md)                   | `SuiX402Payer`, signers, spend caps, receipts, errors        |
| [Guide: gasless](guides/gasless.md)           | Sponsored payments: pay with zero SUI via the gas station    |
| [Facilitator runbook](facilitator-runbook.md) | Run the reference facilitator locally or on Fly/Railway      |
| [FAQ](faq.md)                                 | Short answers to recurring questions                         |

| Project             |                                                                  |
| ------------------- | ---------------------------------------------------------------- |
| [Status](status.md) | What is proven, what is pending, live-test setup, mainnet gating |

Package references live next to the code: [`core`](../packages/core/README.md),
[`payer-sui`](../packages/payer-sui/README.md), [`hono`](../packages/middleware-hono/README.md),
[`express`](../packages/middleware-express/README.md), [`next`](../packages/middleware-next/README.md).
