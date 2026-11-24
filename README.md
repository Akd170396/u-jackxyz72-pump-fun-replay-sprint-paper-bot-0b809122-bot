# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Akd170396/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Akd170396/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Build a bot that trades 10 SOL of paper money on a 24h pump.fun replay. Best net PnL wins. Free to enter.

## Strategy

A spray-and-pyramid paper trader, designed from the dev window's own data (1,222 mints, 35 completions):

- **Cheap discovery.** Every newborn coin is watched for free from the event stream. Only coins with >=3 SOL of early buy flow earn a 0.0025 SOL spray — the spray is a discovery ticket, not the position.
- **Proof before size.** A sprayed coin must attract >=60 SOL of buy flow in its first 600 slots to prove strong. In the dev data every completed coin cleared that bar, and 31.5% of the coins that clear it complete.
- **Staged pyramid.** Strong coins are built up in 0.05 SOL stages, each stage only when the price sits 50% above the last add and above the blended cost — never adding into a dump.
- **Scale-out exits.** A quarter of the tokens is banked at +50%, +100% and +200% above the blended cost; the rest rides to a +500% take-profit or a -30% stop. No trailing stop: every runner has pullbacks on the way up, and the trail kept selling them before they could pay.

Everything is deterministic: no clock, no randomness, no network — the same window always produces the same action log.

## Run it

```sh
node main.ts
```

Requires Node 22.18 or later (the grader runs Node 22.23.4, which runs TypeScript as it is). The harness speaks NDJSON over stdin/stdout; see the competition kit for the protocol.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s3svssng&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
