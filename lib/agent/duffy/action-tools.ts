/**
 * Duffy's action-layer proposer — propose_action_task (2026-06-16).
 *
 * Lets Duffy file a task for the LOCAL WATCHER (`scripts/action-watcher.mjs`)
 * to execute unattended. This is the producer half of the action layer; the
 * watcher is the consumer. Spec: vault `06 - AI Data/Duffy Workspace/
 * action-layer-spec.md` (§9, §12) + `watcher-spec.md`.
 *
 * Why a dedicated tool instead of teaching the raw .md format in the prompt:
 * the action file has strict shape (frontmatter id MUST equal filename,
 * `## Command` / `## Prompt` fenced blocks, ISO+08:00 timestamp). Hand-written
 * by the model, any drift → the watcher rejects it (id_mismatch / parse_failed).
 * Here the CODE builds the file, so the format is correct by construction and
 * the zod schema rejects bad args at call time. Mirrors propose_schedule being
 * the only way schedules get created.
 *
 * Mechanism: reuses the existing `file_create` intent kind — the tool packages
 * a (path, content) targeting `04 - Action/pending/<id>.md`. On Yen's approve,
 * the file_create materialiser writes it; the watcher then picks it up. Path is
 * NOT under Duffy Workspace, so it is GATED (Yen taps approve) by design.
 *
 * Structural guard (the 2026-06-15 「假性成功」 fix, enforced at the source):
 *   type: shell + intent: write is REFUSED. A shell watcher only runs bash and
 *   will NOT edit files — filing a grep/cat stub under intent:write produced a
 *   fake "success" where nothing was written. Code edits MUST use type:llm_task.
 */

import { tool } from "ai";
import { z } from "zod";
import { createIntent } from "@/lib/agent/storage/intents";
import type { Importance } from "@/lib/agent/storage/types";

/** Working dirs the watcher trusts for llm_task auto-execution
 *  (mirror of allowlist.json `types.llm_task.safe_working_dirs`). */
const SAFE_WORKING_DIRS = [
  "~/Desktop/Yen/Develop/yen-hub",
  "~/Desktop/Yen/Yen_Vault/06 - AI Data/Duffy Workspace",
  "~/Desktop/Yen/Yen_Vault/06 - AI Data/Observations",
  "~/Desktop/Yen/Yen_Vault/06 - AI Data/Summaries",
  "~/Desktop/Yen/Yen_Vault/06 - AI Data/Silhouettes",
];

/** Local-time parts + ISO with the machine's real offset — matches the
 *  watcher's nowIso() so id / proposed_at line up with how the watcher stamps. */
function nowParts(): { id: string; iso: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = d.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hms = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return {
    id: `${date}_${hms}`,
    iso: `${date}T${time}${sign}${oh}:${om}`,
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
}

export const proposeActionTask = tool({
  description:
    "File a task for Yen's LOCAL WATCHER to run unattended. Use ONLY when Yen wants something EXECUTED on his machine without him driving it — e.g. 「依這份規格改 yen-hub 的 X 檔」 (code edit), 「跑 tsc 看有沒有壞」 (check). For ordinary vault notes use propose_new_file/propose_edit_file; to just LOOK at code now, read it yourself.\n" +
    "Two task types:\n" +
    "  • task_type:'llm_task' — spawns Claude Code to DO real work (edit code per a spec, tidy files). REQUIRED for any code edit. Provide `prompt` (the full spec) + `working_dir` (a trusted repo).\n" +
    "  • task_type:'shell' — runs ONE bash command. READ/VERIFY only (tsc, git status/log/diff, npm test, ls, grep). Provide `command`.\n" +
    "HARD RULE: editing code with task_type:'shell' is refused — a shell task cannot edit files. Use llm_task.\n" +
    "Gated: the task only reaches the queue after Yen approves the card. End your reply with <<INTENT:${intent_id}>>.",
  inputSchema: z.object({
    task_type: z
      .enum(["shell", "llm_task"])
      .describe(
        "'llm_task' to edit code / do LLM work (uses ## Prompt); 'shell' for a single read-only bash command (uses ## Command).",
      ),
    intent: z
      .enum(["read", "write", "verify"])
      .describe(
        "What the task DOES. 'write' = produces/edits files (llm_task only). 'read' = inspect. 'verify' = check (tsc/test).",
      ),
    slug: z
      .string()
      .min(2)
      .max(40)
      .describe("Short kebab-case label for the filename, e.g. 'palette-resize'."),
    reason: z
      .string()
      .min(10)
      .max(300)
      .describe("One line: why this task exists. Shown on the approval card and in the action log."),
    command: z
      .string()
      .max(2_000)
      .optional()
      .describe("shell only: the single bash command (read/verify). No `rm`, redirects, curl, sudo — those are denied."),
    prompt: z
      .string()
      .max(12_000)
      .optional()
      .describe("llm_task only: the FULL spec of what Claude Code should do, written as if briefing an engineer with no prior context."),
    working_dir: z
      .string()
      .max(200)
      .optional()
      .describe(
        `llm_task only: repo the work happens in. For auto-run pick a trusted dir: ${SAFE_WORKING_DIRS.join(", ")}. Others still run but need a second manual approval.`,
      ),
    max_turns: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("llm_task only: cap on Claude Code turns (default 10, max 20)."),
    importance: z.enum(["high", "medium", "low"]).default("medium"),
  }),
  execute: async ({
    task_type,
    intent,
    slug,
    reason,
    command,
    prompt,
    working_dir,
    max_turns,
    importance,
  }) => {
    // Structural guard — the 2026-06-15 fix at the source.
    if (task_type === "shell" && intent === "write") {
      return {
        ok: false as const,
        error:
          "shell 任務不能改 code（watcher 只跑 bash、不會編輯檔案）。改 code 請用 task_type:'llm_task'，把規格寫進 prompt、working_dir 指向 repo。",
      };
    }
    if (task_type === "shell" && !command?.trim()) {
      return { ok: false as const, error: "task_type:'shell' 需要 command。" };
    }
    if (task_type === "llm_task" && !prompt?.trim()) {
      return { ok: false as const, error: "task_type:'llm_task' 需要 prompt（完整規格）。" };
    }
    if (task_type === "llm_task" && !working_dir?.trim()) {
      return { ok: false as const, error: "task_type:'llm_task' 需要 working_dir（目標 repo）。" };
    }

    const { id: stamp, iso } = nowParts();
    const id = `${stamp}_duffy_${slugify(slug)}`;
    const path = `04 - Action/pending/${id}.md`;

    const fm = [
      "---",
      `id: ${id}`,
      `type: ${task_type}`,
      `intent: ${intent}`,
      "agent: duffy",
      `proposed_at: ${iso}`,
      // The IntentCard approval IS the human gate — by the time this file lands
      // in pending/, Yen has already approved it. So mark it auto_approve so the
      // watcher runs it without a redundant second gate. For llm_task the
      // watcher still downgrades to manual if working_dir is outside its
      // safe_working_dirs (validate §13); shell uses the blanket-auto policy.
      "auto_approve: true",
      ...(task_type === "llm_task"
        ? [`working_dir: ${working_dir!.trim()}`, `max_turns: ${max_turns ?? 10}`]
        : []),
      `reason: ${JSON.stringify(reason)}`,
      "---",
      "",
    ];
    const body =
      task_type === "llm_task"
        ? ["## Prompt", "", prompt!.trim(), ""]
        : ["## Command", "", "```bash", command!.trim(), "```", ""];
    const content = [...fm, ...body].join("\n");

    const created = await createIntent({
      kind: "file_create",
      proposed_by: "duffy",
      rationale: reason,
      evidence: [],
      importance: importance as Importance,
      payload: { path, content, rationale: reason },
    });

    return {
      ok: true as const,
      intent_id: created.id,
      status: created.status,
      action_id: id,
      pending_path: path,
      reminder: "End your text response with the sentinel: <<INTENT:" + created.id + ">>",
    };
  },
});
