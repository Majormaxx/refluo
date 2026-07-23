// Real reads backing the "Proposal/timelock queue" panel (PRD 8.2).
// Timelock exposes get_proposal(id) but no list-all-pending function
// (confirmed from contracts/timelock/src/lib.rs), so the pending set is
// reconstructed the same event-sourced way this workspace already proved
// out for HealthMonitor's pause history (adr/0019): every real
// ProposeEvent names a real id, subtract any id that also has a real
// ExecuteEvent or CancelEvent, and get_proposal() the remainder for the
// still-pending detail (target/fn_name/eta/proposer), watcher-transparent
// to anyone, no auth required to view (PRD 8.2's own wording).
import "server-only";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { Client as TimelockClient } from "dashboard-timelock-client";
import { NETWORK_PASSPHRASE, RPC_URL, TIMELOCK_ID, server } from "../stellar";
import { withRetry } from "../withRetry";

const timelock = new TimelockClient({
  contractId: TIMELOCK_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

// Default of 10,000 ledgers (~14h), not a day-count: the public testnet
// RPC's practical getEvents retention fluctuates live (adr/0021,
// healthMonitor.ts's own header comment has the full binary-search
// finding) and 10,000 was the one value that held safely across two
// separate rounds of testing, both well short of Timelock's own 24h
// PROPOSAL_DELAY. A proposal older than this lookback but still
// genuinely pending exists on-chain and is directly readable via
// get_proposal(id), it just will not appear in this reconstructed queue.
// Raise this (in ledgers, not days, to keep the unit consistent with
// what actually bounds it) if your RPC provider retains events further
// back than this one does right now.
const LOOKBACK_LEDGERS = Number(process.env.TIMELOCK_PROPOSALS_LOOKBACK_LEDGERS ?? "10000");

export interface PendingProposal {
  id: string;
  etaSeconds: number;
  target: string;
  fnName: string;
  proposer: string;
  /** The real on-chain calldata (PRD 8.2's own wording), each arg
   * native-decoded then JSON-stringified — Proposal.args is a Vec<Val>
   * that can hold arbitrary shapes (addresses, amounts, nested structs),
   * with no arg-name metadata available generically to label them, so a
   * formatted per-arg string is the most honest generic display. Amounts
   * decode to bigint, which JSON.stringify throws on natively, hence the
   * replacer. */
  args: string[];
}

function jsonStringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export async function fetchPendingProposals(): Promise<PendingProposal[]> {
  const latestLedger = await withRetry(() => server.getLatestLedger());
  const startLedger = Math.max(2, latestLedger.sequence - LOOKBACK_LEDGERS);

  const proposedIds = new Map<string, number>(); // id -> eta (from the event, cheap, no extra call yet)
  const resolvedIds = new Set<string>(); // executed or cancelled

  // Real event topic names are the full struct name in snake_case
  // (confirmed live: a real propose()+cancel() round trip decoded as
  // "propose_event"/"cancel_event", not the bare verb the function names
  // use), the same lesson adr/0017's USDC topics and adr/0019's
  // HealthMonitor topics already taught this workspace: read the real
  // emitted event, never assume the shape from the Rust struct name.
  // ExecuteEvent's shape (topics: ["execute_event", id], value: {}) is
  // inferred from CancelEvent's identical single-topic-field struct
  // shape, not independently live-verified: a real execute() needs the
  // full real 24h PROPOSAL_DELAY to elapse first, not reproducible in a
  // single session (see adr/0021's disclosed gap).
  const proposeTopic = xdr.ScVal.scvSymbol("propose_event").toXDR("base64");
  const executeTopic = xdr.ScVal.scvSymbol("execute_event").toXDR("base64");
  const cancelTopic = xdr.ScVal.scvSymbol("cancel_event").toXDR("base64");

  let cursor: string | undefined;
  for (;;) {
    const response = await withRetry(() =>
      cursor
        ? server.getEvents({
            filters: [
              {
                type: "contract",
                contractIds: [TIMELOCK_ID],
                topics: [[proposeTopic, "*"], [executeTopic, "*"], [cancelTopic, "*"]],
              },
            ],
            cursor,
            limit: 1000,
          })
        : server.getEvents({
            filters: [
              {
                type: "contract",
                contractIds: [TIMELOCK_ID],
                topics: [[proposeTopic, "*"], [executeTopic, "*"], [cancelTopic, "*"]],
              },
            ],
            startLedger,
            limit: 1000,
          }),
    );

    for (const event of response.events) {
      const topicName = scValToNative(event.topic[0]) as string;
      const id = (scValToNative(event.topic[1]) as bigint).toString();
      if (topicName === "propose_event") {
        const data = scValToNative(event.value) as { eta: bigint };
        proposedIds.set(id, Number(data.eta));
      } else {
        resolvedIds.add(id);
      }
    }
    if (response.events.length < 1000) {
      break;
    }
    cursor = response.cursor;
  }

  const pending: PendingProposal[] = [];
  for (const [id, etaSeconds] of proposedIds) {
    if (resolvedIds.has(id)) {
      continue;
    }
    const proposalTx = await withRetry(() => timelock.get_proposal({ id: BigInt(id) }));
    const proposalResult = (await withRetry(() => proposalTx.simulate())).result;
    // A real-but-consumed proposal (executed/cancelled just outside this
    // lookback window's resolved-event visibility) comes back Err here
    // rather than showing stale data; skip it instead of surfacing a
    // broken row.
    if (proposalResult.isErr()) {
      continue;
    }
    const proposal = proposalResult.unwrap();
    pending.push({
      id,
      etaSeconds,
      target: proposal.target,
      fnName: proposal.fn_name,
      proposer: proposal.proposer,
      // Real finding, confirmed live against a real deployed timelock
      // (a real propose() with two Address args): unlike raw event
      // topics/values (which need scValToNative), the generated client
      // already native-decodes Proposal.args itself — each element here
      // is already a plain JS value (string/number/bigint/...), not a raw
      // ScVal, so no additional scValToNative call belongs here.
      args: proposal.args.map((arg) => jsonStringifyWithBigInt(arg)),
    });
  }

  return pending.sort((a, b) => a.etaSeconds - b.etaSeconds);
}
