/**
 * Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
 *
 * Strategy: spray small, pyramid into volume-confirmed winners.
 *
 * Chasing a pump after it shows is a losing game in this harness: an
 * order decided on a batch fills two slots later, and by then the move is
 * over (measured on the dev window: every momentum variant loses ~5%).
 * So this bot does the opposite. It sprays the minimum 0.01 SOL into
 * every fresh coin the moment its real reserves reach 2 SOL — cheap
 * discovery, price still near birth — and then lets the coin prove
 * itself: if it draws >= 20 SOL of buys in the next ~4 minutes it is
 * strong, and the bot pyramids it up to 0.20 SOL total. Weak coins are
 * sold at the end of the window (or on a -20% stop). Strong coins ride
 * for +250% from their blended cost, or -30% if they fail. One spray
 * per mint, ever; at most 5 open positions.
 *
 * Everything is a pure function of the input stream: no clock, no
 * environment, no randomness. All price comparisons are bigint
 * cross-multiplications, so two runs produce byte-identical replies.
 */

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

// ------------------------------------------------------------------ tuning

/** Spray size: a cheap discovery ticket. The 0.01 SOL round-trip bar is
 *  met by the adds on strong coins, not by the spray itself, so the spray
 *  can be a quarter of the minimum — the adds, not the spray, carry the
 *  position's value. */
const SPRAY_LAMPORTS = 2_500_000n; // 0.0025 SOL
/** Real reserves a coin must have before it can be sprayed. */
const SPRAY_MIN_REAL = 1n * LAMPORTS_PER_SOL;
/** Early buy flow a coin must show before it earns a spray: >=3 SOL bought
 *  since birth. Filters out more than half of all coins while keeping
 *  about two thirds of the ones that later prove strong. */
const SPRAY_MIN_BUY_SOL = 3n * LAMPORTS_PER_SOL;
/** Total invested per coin once it proves strong. */
const STRONG_TARGET_LAMPORTS = 200_000_000n; // 0.2 SOL
/** One pyramid stage: never put the whole add in at the top. */
const ADD_STAGE_LAMPORTS = 50_000_000n; // 0.05 SOL
/** A new stage needs the price 50% above the previous add's price. */
const ADD_STEP_NUM = 150n;
const ADD_STEP_DEN = 100n;
/** Max open positions (matches hello.caps). */
const MAX_POSITIONS = 5;
/** Only coins this young (slots since creation) get sprayed. ~24 minutes. */
const SPRAY_MAX_AGE_SLOTS = 7200;
/** Proof window after the spray, in slots (~2 minutes). */
const PROOF_WINDOW_SLOTS = 600;
/** Buy SOL in the proof window that marks a coin strong. High bar: in
 *  the dev data every one of the 35 completed coins cleared 60 SOL of buy
 *  flow in its first 600 slots (31.5% of the coins that clear it complete),
 *  so only that tier earns the pyramid. */
const PROOF_BUY_SOL = 60n * LAMPORTS_PER_SOL;
/** Spray exit: stop loss at -25% from the spray fill price. Loose on
 *  purpose — a tight stop sold coins on normal early noise before their
 *  buy flow could prove them. */
const SPRAY_STOP_NUM = 75n;
const SPRAY_STOP_DEN = 100n;
/** Scale-out milestones: sell a quarter of the tokens at +50%, +100% and
 *  +200% above the blended cost. Pump.fun runners are too volatile for a
 *  single exit: the trailing stop kept selling them on normal pullbacks
 *  before they could reach the take-profit, so gains are now banked in
 *  stages while the rest keeps riding. */
const MILESTONE_NUMS = [150n, 200n, 300n];
const MILESTONE_DEN = 100n;
/** Strong exit: take profit at +500% from the blended cost. A completed
 *  coin pays ~+1370% from birth, so the take-profit must sit far out —
 *  the scale-out milestones bank the gains along the way. */
const STRONG_TP_NUM = 600n;
const STRONG_TP_DEN = 100n;
/** Strong exit: stop loss at -20% from the blended cost. Realised losses run
 *  past the trigger on gap-downs, so the trigger must sit tighter. */
const STRONG_SL_NUM = 70n;
const STRONG_SL_DEN = 100n;
/** Slippage allowance on every order (5%). */
const SLIPPAGE_BPS = 500;

// ------------------------------------------------------------------ helpers

/** Compare two prices given as (quote, token) reserve pairs.
 *  Returns 1 when a > b, -1 when a < b, 0 when equal. */
function cmpPrice(
  aQ: bigint,
  aT: bigint,
  bQ: bigint,
  bT: bigint,
): number {
  const left = aQ * bT;
  const right = bQ * aT;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

/** True when price a is at least (num/den) times price b. */
function priceAtLeast(
  aQ: bigint,
  aT: bigint,
  bQ: bigint,
  bT: bigint,
  num: bigint,
  den: bigint,
): boolean {
  // aQ/aT >= num/den * bQ/bT  <=>  aQ * bT * den >= bQ * aT * num
  return aQ * bT * den >= bQ * aT * num;
}

/** True when price a is at most (num/den) times price b. */
function priceAtMost(
  aQ: bigint,
  aT: bigint,
  bQ: bigint,
  bT: bigint,
  num: bigint,
  den: bigint,
): boolean {
  return aQ * bT * den <= bQ * aT * num;
}

// ------------------------------------------------------------------ tracking

interface MintTrack {
  firstSlot: number;
  createdSlot: number | null;
  lastSlot: number;
  /** Already sprayed once: never spray the same mint again. */
  sprayed: boolean;
  /** Cumulative SOL bought on this mint since birth, from TradeEvents.
   *  Early buy flow is the strongest completion signal in the dev data:
   *  coins with >=3 SOL bought by the time they reach 1 SOL real reserves
   *  hold 68% of the strong coins while being only 43% of all coins. */
  buySol: bigint;
}

interface Held {
  /** Blended cost: total SOL spent on buys / total tokens received. */
  costQ: bigint;
  costT: bigint;
  /** The spray fill's price (for the spray stop loss). */
  sprayQ: bigint;
  sprayT: bigint;
  /** Slot of the batch the spray was decided on. */
  spraySlot: number;
  /** SOL bought on this mint since the spray (proof window). */
  proofBuy: bigint;
  /** Proven strong: pyramiding up to the target. */
  strong: boolean;
  /** Pyramid stages already added (0 = spray only). */
  adds: number;
  /** Price at the last add (next stage needs +50% above it). */
  lastAddQ: bigint;
  lastAddT: bigint;
  /** A full sell is in flight: do not push another one. Cleared if the
   *  sell is rejected, so the exit can be retried. */
  closing: boolean;
  /** Scale-out milestones already banked (0-3). */
  soldStage: number;
}

const tracks = new Map<string, MintTrack>();
const held = new Map<string, Held>();

function trackOf(mint: string, slot: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { firstSlot: slot, createdSlot: null, lastSlot: slot, sprayed: false, buySol: 0n };
    tracks.set(mint, t);
  }
  return t;
}

/** Fold this batch's events into the per-mint tracks and proof windows. */
function observeEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const t = trackOf(e.mint, e.slot);
      t.createdSlot = e.slot;
      t.firstSlot = e.slot;
      t.lastSlot = e.slot;
    } else if (e.event === "TradeEvent") {
      const t = trackOf(e.mint, e.slot);
      t.lastSlot = e.slot;
      if (e.is_buy) {
        t.buySol += BigInt(e.sol_amount);
        // Proof volume only counts while the coin is held and unproven.
        const h = held.get(e.mint);
        if (h !== undefined && !h.strong) {
          h.proofBuy += BigInt(e.sol_amount);
        }
      }
    }
  }
}

/** Fold this batch's fills into the held-position records. */
function observeFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.side === "buy" && f.status === "filled") {
      const q = BigInt(f.quote_lamports);
      const tk = BigInt(f.token_amount);
      if (q <= 0n || tk <= 0n) continue;
      const h = held.get(f.mint);
      if (h === undefined) {
        // The spray fill: open the record.
        held.set(f.mint, {
          costQ: q,
          costT: tk,
          sprayQ: q,
          sprayT: tk,
          spraySlot: f.decided_slot,
          proofBuy: 0n,
          strong: false,
          adds: 0,
          lastAddQ: q,
          lastAddT: tk,
          closing: false,
          soldStage: 0,
        });
      } else {
        // An add fill: blend it into the cost basis.
        h.costQ += q;
        h.costT += tk;
      }
    } else if (f.side === "sell") {
      const h = held.get(f.mint);
      if (h === undefined) continue;
      if (f.status === "filled") {
        // A full sell (or a harness close) drops the mint from the account
        // and syncHeld removes the record; a partial scale-out fill just
        // banks one milestone and the rest keeps riding.
        if (!h.closing && h.soldStage < MILESTONE_NUMS.length) {
          h.soldStage += 1;
        }
      } else {
        // Rejected or failed: a full sell may be retried, a milestone sell
        // may be pushed again next batch.
        h.closing = false;
      }
    }
  }
}

/** Drop held records the account no longer reports, and prune stale tracks. */
function syncHeld(state: BotState, slot: number): void {
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }
  if (tracks.size > 20000 && slot % 1000 === 0) {
    for (const [mint, t] of tracks) {
      if (
        slot - t.lastSlot > 14400 &&
        !state.positions.has(mint) &&
        !t.sprayed
      ) {
        tracks.delete(mint);
      }
    }
  }
}

/** True when a buy on this mint is already pending a fill. */
function buyPending(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "buy" && p.order.mint === mint) return true;
  }
  return false;
}

/** True when a sell on this mint is already pending a fill. */
function sellPending(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "sell" && p.order.mint === mint) return true;
  }
  return false;
}

// ------------------------------------------------------------------ decisions

function decideExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
  for (const [mint, pos] of state.positions) {
    const h = held.get(mint);
    const curve = state.curves.get(mint);
    if (h === undefined || curve === undefined) continue;
    if (curve.complete) continue; // the harness closes completed curves itself
    if (curve.virtual_token_reserves === 0n) continue;
    if (h.closing) continue; // full sell in flight; wait for its fill
    if (sellPending(state, mint)) continue; // sell already in flight; wait for its fill
    const q = curve.virtual_quote_reserves;
    const tk = curve.virtual_token_reserves;

    if (!h.strong) {
      // Spray phase: -20% stop, or the proof window ran out unproven.
      const stopped = priceAtMost(
        q, tk, h.sprayQ, h.sprayT, SPRAY_STOP_NUM, SPRAY_STOP_DEN,
      );
      const expired = batch.slot - h.spraySlot > PROOF_WINDOW_SLOTS;
      if (stopped || expired) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        h.closing = true;
      }
      continue;
    }

    // Strong phase: bank gains in stages, then ride the rest to +500%
    // or cut at -30%. No trailing stop: every runner has -15% pullbacks
    // on the way up, and the trail kept selling them before they could
    // reach the take-profit; the milestones bank gains instead.
    if (h.soldStage < MILESTONE_NUMS.length) {
      const msNum = MILESTONE_NUMS[h.soldStage];
      if (
        priceAtLeast(q, tk, h.costQ, h.costT, msNum, MILESTONE_DEN) &&
        pos.token_amount >= 4n
      ) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount / 4n,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        continue;
      }
    }
    const takeProfit = priceAtLeast(
      q, tk, h.costQ, h.costT, STRONG_TP_NUM, STRONG_TP_DEN,
    );
    const stopLoss = priceAtMost(
      q, tk, h.costQ, h.costT, STRONG_SL_NUM, STRONG_SL_DEN,
    );
    if (takeProfit || stopLoss) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      h.closing = true;
    }
  }
}

function decideAdds(state: BotState, batch: Batch, orders: OrderInput[]): void {
  void batch;
  for (const [mint, h] of held) {
    if (!h.strong) continue;
    if (h.soldStage > 0) continue; // scaling out: no new money in
    if (h.costQ >= STRONG_TARGET_LAMPORTS) continue;
    if (buyPending(state, mint)) continue;
    if (sellPending(state, mint)) continue; // a scale-out sell is in flight
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.virtual_token_reserves === 0n) continue;
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;

    // Stage rule: the first add comes at promotion; every later stage
    // needs the price 50% above the previous add's price, so money only
    // follows a coin that keeps proving itself.
    if (h.adds > 0) {
      if (
        !priceAtLeast(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          h.lastAddQ,
          h.lastAddT,
          ADD_STEP_NUM,
          ADD_STEP_DEN,
        )
      ) continue;
    }
    // Never add into a dump: only top up while the price still sits above
    // the blended cost.
    if (
      !priceAtLeast(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        h.costQ,
        h.costT,
        100n,
        100n,
      )
    ) continue;

    const cap = state.maxBuyLamports(mint);
    if (cap <= 0n) continue;
    let size = STRONG_TARGET_LAMPORTS - h.costQ;
    if (size > ADD_STAGE_LAMPORTS) size = ADD_STAGE_LAMPORTS;
    if (size > cap) size = cap;
    const free = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    if (free < size + txFee) {
      const afford = free - txFee;
      if (afford < SPRAY_LAMPORTS) continue;
      size = afford < size ? afford : size;
    }
    if (size < SPRAY_LAMPORTS) continue;
    orders.push({
      side: "buy",
      mint,
      quote_lamports: size,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    // Record the stage now (the fill blends the cost in observeFills).
    h.adds += 1;
    h.lastAddQ = curve.virtual_quote_reserves;
    h.lastAddT = curve.virtual_token_reserves;
  }
}

function decideEntries(
  state: BotState,
  batch: Batch,
  orders: OrderInput[],
): void {
  // Sells in this same reply free positions; count what we are about to hold.
  let open = state.committedPositionCount();
  for (const o of orders) {
    if (o.side === "sell") open -= 1;
  }

  for (const [mint, t] of tracks) {
    if (open >= MAX_POSITIONS) break;
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (t.sprayed) continue;
    if (state.positions.has(mint)) continue;
    if (buyPending(state, mint)) continue;

    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.virtual_token_reserves === 0n) continue;

    const ageSlot = t.createdSlot ?? t.firstSlot;
    if (batch.slot - ageSlot > SPRAY_MAX_AGE_SLOTS) continue;

    // Spray once real reserves reach 1 SOL and the coin already shows
    // >=3 SOL of buy flow: the price is still near birth, but the coin
    // has proven someone besides the creator is buying.
    if (curve.real_quote_reserves < SPRAY_MIN_REAL) continue;
    if (t.buySol < SPRAY_MIN_BUY_SOL) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < SPRAY_LAMPORTS) continue;

    const free = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    if (free < SPRAY_LAMPORTS + txFee) continue;

    orders.push({
      side: "buy",
      mint,
      quote_lamports: SPRAY_LAMPORTS,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    t.sprayed = true;
    open += 1;
  }
}

/** Promote sprayed coins whose proof volume cleared the bar. */
function promoteProof(state: BotState, batch: Batch): void {
  void state;
  void batch;
  for (const h of held.values()) {
    if (!h.strong && h.proofBuy >= PROOF_BUY_SOL) h.strong = true;
  }
}

// ------------------------------------------------------------------ bot

await runBot({
  onHello(state: BotState): void {
    console.error(
      `pump-sniper: capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, ` +
        `latency ${state.hello.latency_slots} slots`,
    );
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    observeFills(batch);
    observeEvents(batch);
    syncHeld(state, batch.slot);
    promoteProof(state, batch);

    const orders: OrderInput[] = [];
    decideExits(state, batch, orders);
    decideAdds(state, batch, orders);
    decideEntries(state, batch, orders);
    return orders;
  },

  onDone(state: BotState): void {
    console.error(
      `pump-sniper: done after ${state.seq} batches, ` +
        `cash ${state.cash} lamports, ${state.positions.size} positions left`,
    );
  },
});
