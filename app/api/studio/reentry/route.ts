/**
 * POST /api/studio/reentry — the "接回來" LLM knob.
 *
 * Synthesizes a re-entry brief for one project: "上次做到 X · 你留的下一步 Y ·
 * 別踩 Z". Inputs (all deterministic, gathered by state.ts):
 *   - 冷幾天 / 未提交數 / 近 6 筆 commit subject
 *   - 該 project 的 checkpoint memory 摘要
 *
 * The heavy lifting is done by generateText — this route only picks the
 * project, formats the prompt, and returns the text.
 *
 * No caching: cheap enough to regenerate on demand (a couple of git calls +
 * one LLM turn), and the whole point is that it's fresh vs the frozen
 * checkpoint memory next to it.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { getSession } from "@/lib/auth/session";
import {
  hasAnyLLMKey,
  modelLabel,
  pickModel,
} from "@/lib/ai/model";
import { readStudioState } from "@/lib/studio/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SYSTEM = `You are Duffy, writing a 3-line "接回來" brief for Yen when he re-enters a project after being away.

Structure — exactly three lines, no headings, no preamble:
  上次做到 → <one sentence, concrete, based on the commits given>
  下一步   → <what to do next, taking checkpoint's next-step into account if given; otherwise infer conservatively from commits>
  別踩     → <one specific landmine from the checkpoint if it has one; otherwise say "checkpoint 無明示,自行判斷" — do not invent>

Rules:
- Traditional Chinese (Taiwan). Direct, present, no filler.
- Reference concrete details from the commits/checkpoint (a file, a number, a decision). Don't paraphrase into vagueness.
- If the project is 冷 many days, name the cold gap plainly in "上次做到".
- If there are 未提交, say so in "下一步" — closing loose ends is usually the right next move.
- Never invent facts not in the input. If a field is empty, say so.`;

export async function POST(req: NextRequest) {
  if (process.env.DEV_BYPASS_AUTH !== "1") {
    const session = await getSession();
    if (!session.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  let body: { project?: string };
  try {
    body = (await req.json()) as { project?: string };
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const project = body.project ?? "";
  const target = readStudioState().find((p) => p.name === project);
  if (!target) {
    return NextResponse.json(
      { error: `unknown project: ${project}` },
      { status: 400 },
    );
  }

  if (!hasAnyLLMKey()) {
    // Loud fallback — Yen's rule: no silent LLM absence.
    const cold =
      target.daysCold != null ? `冷 ${target.daysCold} 天` : "冷期不明";
    return NextResponse.json({
      brief: `（無 LLM key,以下為 deterministic 拼湊)
上次做到 → ${target.recentCommits[0] ?? "無 commit"}(${cold})
下一步   → ${target.uncommitted > 0 ? `收 ${target.uncommitted} 未提交` : "checkpoint 有的話讀 memo"}
別踩     → ${target.checkpointName ? "見 " + target.checkpointName : "checkpoint 無,自行判斷"}`,
      model: "fallback",
      no_llm_key: true,
    });
  }

  const parts: string[] = [];
  parts.push(`# 專案:${target.name}`);
  parts.push(
    target.lastCommit
      ? `# 冷幾天:${target.daysCold} 天(最後 commit ${target.lastCommit})`
      : "# 冷幾天:未知",
  );
  parts.push(`# 未提交:${target.uncommitted} 檔`);
  parts.push(
    `# 近 6 筆 commit(新→舊):\n${
      target.recentCommits.length === 0
        ? "(無)"
        : target.recentCommits.map((c) => `- ${c}`).join("\n")
    }`,
  );
  parts.push(
    `# checkpoint 記憶${target.checkpointName ? "(" + target.checkpointName + ")" : "(無)"}:\n${
      target.checkpointExcerpt ?? "(無)"
    }`,
  );

  try {
    const result = await generateText({
      model: pickModel(),
      system: SYSTEM,
      prompt: parts.join("\n\n"),
    });
    // Fire-and-forget token usage (matches coach.ts pattern).
    try {
      const { recordTokenUsage } = await import(
        "@/lib/agent/storage/token-usage"
      );
      // "other" bucket to avoid touching token-usage.ts's CallSite union
      // (keeps this slice as new-files-only). Widen the union in a later
      // slice if studio-reentry usage warrants its own line item.
      await recordTokenUsage({
        call_site: "other",
        model: modelLabel(),
        usage: result.usage,
      });
    } catch {
      /* swallow */
    }
    return NextResponse.json({ brief: result.text.trim(), model: modelLabel() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
