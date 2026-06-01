/**
 * Agent storage types — Intent / Observation / Provenance.
 *
 * Designed SQL-friendly so the JSON-file storage layer (Slice 6) can migrate
 * to SQLite / Turso in a later slice without touching call sites. See
 * `lib/agent/storage/intents.ts` and `observations.ts` for the JSON impl.
 *
 * — Slice 6 / 2026-06-02
 */

/* -------------------------------------------------------------------------- */
/*  Provenance — every agent-touched record carries source attribution.       */
/* -------------------------------------------------------------------------- */

export type ProvenanceSource =
  | "user" // Yen wrote it directly
  | "agent" // an agent wrote it (must go via intent)
  | "user-via-agent" // Yen told the agent to write it (still goes via intent)
  | "legacy"; // pre-Slice-6 data, source unknown

/* -------------------------------------------------------------------------- */
/*  Evidence — what observation / intent is backed by.                        */
/* -------------------------------------------------------------------------- */

export type EvidenceRef =
  | {
      kind: "attention";
      zone: string; // e.g. "septic", "writing"
      metric: "total" | "added" | "opened" | "hoardRatio";
      value: number;
      window?: number; // days
    }
  | {
      kind: "vault_file";
      path: string; // relative to vault root
    }
  | {
      kind: "todo";
      file: string;
      text: string; // first ~80 chars
    }
  | {
      kind: "observation";
      id: string; // ref to prior observation
    };

/* -------------------------------------------------------------------------- */
/*  Observation — the first "thing Duffy can write".                          */
/*                                                                            */
/*  A structured note about Yen's state. Lives in observations.json AFTER     */
/*  Yen approves the corresponding intent.                                    */
/* -------------------------------------------------------------------------- */

export type ObservationPayload = {
  title: string; // one-line summary, shown in card header
  body: string; // full description
  zone?: string; // attention zone if relevant
  window?: { days: number }; // observation time window
};

export type Observation = {
  id: string;
  source_intent: string; // the Intent.id this came from
  title: string;
  body: string;
  zone?: string;
  window?: { days: number };
  evidence: EvidenceRef[];
  source: Extract<ProvenanceSource, "agent" | "user-via-agent">;
  source_agent_id?: string; // e.g. "duffy"
  reason: string; // mirrors Intent.rationale at the moment of approval
  created_at: number; // epoch ms (approval time)
};

/* -------------------------------------------------------------------------- */
/*  Intent — an agent's proposal awaiting Yen's decision.                     */
/* -------------------------------------------------------------------------- */

export type IntentKind = "observation"; // Slice 7+ adds more

export type IntentPayload = ObservationPayload; // discriminated by kind once we add more

export type IntentStatus = "pending" | "approved" | "rejected";

export type Intent = {
  id: string;
  kind: IntentKind;
  payload: IntentPayload;
  proposed_by: string; // agent id, e.g. "duffy"
  proposed_at: number; // epoch ms
  status: IntentStatus;
  rationale: string; // why the agent thinks this is worth proposing
  evidence: EvidenceRef[];
  decided_at?: number;
  decided_by?: "user";
  // when approved, the resulting observation id (for backlinking)
  resulted_in?: string;
};

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fresh intent id. Uses crypto.randomUUID() for parity with
 * lib/conversations/store.ts; short prefix lets us tell them apart in logs.
 */
export function newIntentId(): string {
  return `int_${crypto.randomUUID()}`;
}

export function newObservationId(): string {
  return `obs_${crypto.randomUUID()}`;
}
