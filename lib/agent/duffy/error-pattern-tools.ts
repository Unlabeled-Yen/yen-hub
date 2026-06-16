/**
 * Error-pattern log (2026-06-16, PRD v2 Gap B) — durable external memory of
 * mistakes Yen has corrected, so one correction earns long-term interest
 * instead of being paid as tuition again. Appends to
 * `06 - AI Data/Duffy Workspace/error-patterns.md` (Duffy's sandbox — writes
 * there auto-execute with no approval, per Slice α). Reading back uses the
 * ordinary read_vault_file on that path.
 *
 * Design note: a dedicated tool, not "remember to edit a file", because
 * durable external state beats a prompt nudge. The CALL is still prompt-driven
 * (a known ceiling of single-LLM self-correction); the STORAGE is solid.
 */

import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { vaultPath } from "@/lib/vault/reader";

export const ERROR_PATTERNS_REL = "06 - AI Data/Duffy Workspace/error-patterns.md";

const HEADER =
  "# Duffy 錯誤模式庫\n\n" +
  "> Duffy 自動歸檔。被 Yen 糾正後呼叫 `log_error_pattern` 寫一列。\n" +
  '> 處理新請求前，若疑似踩過的坑，用 `read_vault_file("' +
  ERROR_PATTERNS_REL +
  '")` 自檢。\n\n' +
  "| 日期 | 錯誤類型 | 觸發情境 | 規避策略 |\n|---|---|---|---|\n";

/** Keep the markdown table intact — collapse newlines, escape pipes. */
function clean(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export const logErrorPattern = tool({
  description:
    "Record a mistake Yen JUST corrected you on, so it becomes durable, searchable external state — not a fleeting apology. Call this right after a correction. One row per distinct pattern. This is how a single correction earns interest instead of you paying the same tuition twice. The file is in your workspace; read it back anytime with read_vault_file.",
  inputSchema: z.object({
    pattern: z
      .string()
      .min(4)
      .max(120)
      .describe("錯誤類型，一句話。e.g. '宣稱沒有工具前未做三搜'"),
    trigger: z.string().max(200).describe("什麼情境會觸發這個錯誤"),
    fix: z.string().max(200).describe("當前規避策略 / 正確做法"),
  }),
  execute: async ({ pattern, trigger, fix }) => {
    const abs = join(vaultPath(), ERROR_PATTERNS_REL);
    const iso = new Date().toISOString().slice(0, 10);
    const row = `| ${iso} | ${clean(pattern)} | ${clean(trigger)} | ${clean(fix)} |\n`;
    let prefix = "";
    try {
      await fs.access(abs);
    } catch {
      await fs.mkdir(dirname(abs), { recursive: true });
      prefix = HEADER;
    }
    await fs.appendFile(abs, prefix + row, "utf8");
    return { ok: true as const, logged: clean(pattern), path: ERROR_PATTERNS_REL };
  },
});
