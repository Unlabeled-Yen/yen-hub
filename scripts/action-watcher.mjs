#!/usr/bin/env node
// action-watcher.mjs · v0.1（含 action-layer-spec v0.3 §9 scope-smuggling 檢核）
// Spec: Yen_Vault/06 - AI Data/Duffy Workspace/watcher-spec.md
//
// 用法：
//   node action-watcher.mjs           # 常駐輪詢
//   node action-watcher.mjs --once    # 跑一輪即退出（測試用）
//   node action-watcher.mjs --dry     # 跑一輪但不寫入任何 completed/rejected/log（純檢視）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawnSync } from "node:child_process";

const HOME = os.homedir();
const VAULT = path.join(HOME, "Desktop/Yen/Yen_Vault");
const PENDING_DIR = path.join(VAULT, "04 - Action/pending");
const COMPLETED_DIR = path.join(VAULT, "04 - Action/completed");
const REJECTED_DIR = path.join(VAULT, "04 - Action/rejected");
const META_DIR = path.join(VAULT, "04 - Action/_meta");
const ALLOWLIST_PATH = path.join(META_DIR, "allowlist.json");
const COOLDOWN_PATH = path.join(META_DIR, "cooldown.json");
const LOG_PATH = path.join(META_DIR, "action-log.md");
const ARCHIVE_DIR = path.join(META_DIR, "archive");

const POLL_INTERVAL_MS = 30_000;
const STALE_DAYS = 7;
const LOG_ROTATE_LINES = 1000;

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has("--once");
const DRY = ARGS.has("--dry");

// v0.3 §9 scope-smuggling 寫入語意詞
const WRITE_VERBS_ZH = ["實作", "建立", "新建", "寫入", "產生", "安裝", "設定", "修改", "編輯", "補上"];
const WRITE_VERBS_EN = ["implement", "create", "build", "write", "install", "generate", "edit", "add", "modify"];

// v0.5 §9b（2026-06-16）— §9 鏡像守衛用：明確唯讀的 shell 命令字首。
// 只列「保證不寫檔」的；sed/awk/tee/dd 等可寫的故意排除，git 只認唯讀子命令。
// 守衛只在「整條命令的每一段都唯讀」時才開火——寧可放過模糊命令，不誤擋真寫入。
const READONLY_BINS = new Set([
  "grep", "rg", "egrep", "fgrep", "cat", "head", "tail", "less", "more",
  "ls", "find", "fd", "wc", "echo", "pwd", "stat", "file", "tree", "du",
  "df", "sort", "uniq", "cut", "tr", "diff", "test", "true", "which", "type",
]);
const GIT_READONLY_SUB = new Set([
  "status", "log", "diff", "show", "ls-files", "branch", "rev-parse",
  "blame", "cat-file", "describe", "remote", "config",
]);

/** 判斷一條 shell 命令是否「整條都是純讀取」（含空命令）。
 *  以 ; | && || 切段，每段取首詞比對白名單；git 另看子命令。
 *  任一段不在白名單 → 視為可能寫入 → return false（不誤擋）。*/
function isPurelyReadOnlyCommand(command) {
  let cmd = (command ?? "").trim();
  if (!cmd) return true; // 空命令：write intent 卻什麼都沒跑 = 名實不符
  // 先把引號內字串抽成中性 token，避免 pattern 裡的 | ; && 被誤當命令分隔
  // （例：grep -nE "scroll|thinking" 的 | 不是 pipe）。
  cmd = cmd.replace(/"[^"]*"/g, " Q ").replace(/'[^']*'/g, " Q ");
  const segments = cmd.split(/\s*(?:&&|\|\||[;|])\s*/).filter(Boolean);
  if (segments.length === 0) return true;
  for (const seg of segments) {
    // 跳過前置 env 賦值（FOO=bar cmd …）
    const toks = seg.trim().split(/\s+/).filter((t) => !/^[A-Za-z_]\w*=/.test(t));
    const bin = (toks[0] ?? "").replace(/^.*\//, ""); // 去路徑前綴
    if (bin === "git") {
      const sub = toks[1] ?? "";
      if (!GIT_READONLY_SUB.has(sub)) return false;
      continue;
    }
    if (!READONLY_BINS.has(bin)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// frontmatter 與 body 解析（純正則，免 gray-matter）
// ----------------------------------------------------------------------------
function parsePendingFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, "");
    fm[kv[1]] = v;
  }
  const body = m[2];
  // 抽 Command 區塊（shell 型）
  const cmdMatch = body.match(/##\s*Command\s*\n+```(?:bash|sh)?\n([\s\S]*?)\n```/);
  const command = cmdMatch ? cmdMatch[1].trim() : "";
  // 抽 Prompt 區塊（llm_task 型）
  const promptMatch = body.match(/##\s*Prompt\s*\n+([\s\S]*?)(\n##\s|$)/);
  const prompt = promptMatch ? promptMatch[1].trim() : "";
  // 抽 Expected Output 區塊
  const expMatch = body.match(/##\s*Expected Output\s*\n+([\s\S]*?)(\n##\s|$)/);
  const expectedOutput = expMatch ? expMatch[1].trim() : "";
  return { fm, body, command, prompt, expectedOutput };
}

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function countLlmTodayFromLog() {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const today = nowIso().slice(0, 10);
  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
  return lines.filter((l) => l.includes(" | llm_task | ") && l.includes(today)).length;
}

// ----------------------------------------------------------------------------
// 驗證鏈
// ----------------------------------------------------------------------------
function validate(file, parsed, allowlist) {
  const { fm, command, expectedOutput } = parsed;
  const id = path.basename(file, ".md");

  if (fm.id !== id) return { ok: false, reason: "id_mismatch" };
  if (!allowlist.types[fm.type]) return { ok: false, reason: "type_not_allowed" };
  if (!fm.reason || String(fm.reason).length < 10) return { ok: false, reason: "reason_too_short" };

  // v0.3 §9 intent 必填
  if (!fm.intent) return { ok: false, reason: "intent_missing" };
  if (!["read", "write", "verify"].includes(fm.intent)) return { ok: false, reason: "intent_invalid" };

  // v0.3 §9 scope-smuggling 檢核（llm_task 豁免：prompt 本身即工作宣告，不存在偷渡）
  if (fm.intent !== "write" && fm.type !== "llm_task") {
    const haystack = (expectedOutput + " " + fm.reason).toLowerCase();
    const hitZh = WRITE_VERBS_ZH.find((w) => haystack.includes(w));
    const hitEn = WRITE_VERBS_EN.find((w) => haystack.includes(w));
    if (hitZh || hitEn) {
      return {
        ok: false,
        reason: `scope_mismatch:intent=${fm.intent}_但偵測到寫入語意詞「${hitZh ?? hitEn}」`,
      };
    }
  }

  // v0.5 §9b（2026-06-16）— §9 的反方向鏡像，堵 2026-06-15「假性成功」事故：
  // intent: write + type: shell，但 Command 整條純讀取（grep/cat/git status…）
  // → 名實不符，真正的寫入從沒發生卻會被標 success。reject 並導向 llm_task。
  // 只擋 shell（llm_task 的 prompt 本身即工作宣告；其他唯讀 type 本就非 write）。
  if (fm.intent === "write" && fm.type === "shell" && isPurelyReadOnlyCommand(command)) {
    return {
      ok: false,
      reason: "scope_mismatch:intent=write_但Command純讀取（或空）；改code請改用type:llm_task",
    };
  }

  // v0.4 §13 llm_task 專屬檢核
  if (fm.type === "llm_task") {
    const rule = allowlist.types.llm_task;
    if (!parsed.prompt) return { ok: false, reason: "llm_task_missing_prompt" };
    if (!fm.working_dir) return { ok: false, reason: "llm_task_missing_working_dir" };
    const wd = expandHome(String(fm.working_dir));
    const safeDirs = (rule.safe_working_dirs ?? []).map(expandHome);
    const isSafe = safeDirs.some((s) => wd.startsWith(s));
    // 如果 working_dir 不在 safe list，強制降為 auto_approve:false（不 reject）
    if (!isSafe && fm.auto_approve === true) {
      return { ok: true, denyHit: `working_dir_not_safe:${wd}` };
    }
    // max_turns cap
    const requested = Number(fm.max_turns ?? 10);
    if (requested > rule.max_turns_cap) {
      return { ok: false, reason: `llm_task_max_turns_exceeds_cap:${requested}>${rule.max_turns_cap}` };
    }
    // daily budget
    const usedToday = countLlmTodayFromLog();
    if (usedToday >= rule.daily_budget) {
      return { ok: false, reason: `llm_task_daily_budget_exhausted:${usedToday}/${rule.daily_budget}` };
    }
  }

  // deny_substrings 掃描（命中時降為 auto_approve:false，不 reject）
  const hitDeny = allowlist.deny_substrings?.find((s) => command.includes(s));
  if (hitDeny) {
    return { ok: true, denyHit: hitDeny };
  }

  return { ok: true };
}

// ----------------------------------------------------------------------------
// 執行 & 寫回
// ----------------------------------------------------------------------------
function nowIso() {
  // +08:00 寫死，沿 spec
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = d.getTimezoneOffset();
  const sign = offsetMin <= 0 ? "+" : "-";
  const oh = pad(Math.abs(offsetMin) / 60 | 0);
  const om = pad(Math.abs(offsetMin) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function execCommand(command) {
  const start = Date.now();
  try {
    const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.status ?? 1,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return { stdout: "", stderr: String(e), exitCode: 1, durationMs: Date.now() - start };
  }
}

const CLAUDE_BIN = path.join(HOME, ".local/bin/claude");

// claude --permission-mode 合法值。預設 acceptEdits：放行檔案編輯（Edit/Write），
// 不放行任意 bash —— 等於「讓 CC 改 code、但不能 rm/curl/亂跑」。要更高權限
// （例如任務需自己跑 build / restore）才在 pending frontmatter 設
// permission_mode: bypassPermissions（無人值守全放行，慎用）。
const LLM_PERMISSION_MODES = new Set([
  "acceptEdits",
  "bypassPermissions",
  "default",
  "auto",
]);

function execLlmTask(prompt, workingDir, maxTurns, permissionMode) {
  // cwd = working_dir（不是 /tmp）。實證（2026-06-15 smoke test）：claude 把
  // 相對路徑的新檔寫在 cwd，不是 --add-dir 的目錄——cwd: "/tmp" 會讓「依規格
  // 建檔」的任務把檔案寫到 /tmp 而非目標 repo。設 cwd = working_dir 才能讓相對
  // 路徑正確，且 CC 讀得到該目錄的 CLAUDE.md（對 code 任務正是要遵守的規約）。
  // 代價：繼承該目錄 CLAUDE.md 的 token（yen-hub ~數 KB，可接受且有益）。
  // 絕對禁用 shell：prompt 含中文標點與多行，shell 會切詞
  const start = Date.now();
  const wd = expandHome(workingDir);
  const mode = LLM_PERMISSION_MODES.has(permissionMode)
    ? permissionMode
    : "acceptEdits";
  const args = [
    "-p", prompt,
    "--add-dir", wd,
    "--permission-mode", mode,
    "--output-format", "json",
  ];
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  try {
    const r = spawnSync(CLAUDE_BIN, args, {
      encoding: "utf8",
      cwd: wd,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(CLAUDE_BIN)}:${process.env.PATH}` },
    });
    const durationMs = Date.now() - start;
    if (r.status !== 0) {
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? `claude -p exited with ${r.status}`,
        exitCode: r.status ?? 1,
        durationMs,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      return {
        stdout: r.stdout ?? "",
        stderr: `JSON parse failed: ${e.message}`,
        exitCode: 1,
        durationMs,
      };
    }
    if (parsed.is_error) {
      return {
        stdout: parsed.result ?? "",
        stderr: parsed.api_error_status ?? "is_error=true",
        exitCode: 1,
        durationMs,
        llmMeta: parsed,
      };
    }
    return {
      stdout: parsed.result ?? "",
      stderr: "",
      exitCode: 0,
      durationMs,
      llmMeta: parsed,
    };
  } catch (e) {
    return { stdout: "", stderr: String(e), exitCode: 1, durationMs: Date.now() - start };
  }
}

function truncateForMd(text, limit = 100) {
  const lines = text.split("\n");
  if (lines.length <= limit) return { embed: text, sidecar: null };
  const head = lines.slice(0, 20);
  const tail = lines.slice(-20);
  return {
    embed: [...head, `...truncated (${lines.length - 40} lines omitted; see sidecar)...`, ...tail].join("\n"),
    sidecar: text,
  };
}

function writeCompleted(id, parsed, result, executedBy) {
  const { fm } = parsed;
  const stdoutTrim = truncateForMd(result.stdout, 100);
  const stderrTrim = truncateForMd(result.stderr, 50);
  const sidecarPath = stdoutTrim.sidecar ? `${id}.stdout.txt` : null;
  const stderrSidecarPath = stderrTrim.sidecar ? `${id}.stderr.txt` : null;
  const status = result.exitCode === 0 ? "success" : "failed";

  const llm = result.llmMeta;
  const fmOut = [
    `---`,
    `id: ${id}`,
    `type: ${fm.type}`,
    `intent: ${fm.intent}`,
    `agent: ${fm.agent}`,
    `proposed_at: ${fm.proposed_at}`,
    `reason: ${JSON.stringify(fm.reason)}`,
    `status: ${status}`,
    `executed_at: ${nowIso()}`,
    `duration_ms: ${result.durationMs}`,
    `exit_code: ${result.exitCode}`,
    `executed_by: ${executedBy}`,
    `stdout_lines: ${result.stdout.split("\n").length}`,
    sidecarPath ? `stdout_sidecar: ${sidecarPath}` : null,
    stderrSidecarPath ? `stderr_sidecar: ${stderrSidecarPath}` : null,
    llm ? `llm_num_turns: ${llm.num_turns}` : null,
    llm ? `llm_cost_usd: ${llm.total_cost_usd?.toFixed(6)}` : null,
    llm ? `llm_input_tokens: ${llm.usage?.input_tokens ?? 0}` : null,
    llm ? `llm_output_tokens: ${llm.usage?.output_tokens ?? 0}` : null,
    llm ? `llm_session_id: ${llm.session_id}` : null,
    `---`,
    ``,
    `## Output`,
    ``,
    "```",
    stdoutTrim.embed || "(empty)",
    "```",
    result.stderr ? `\n## Stderr\n\n\`\`\`\n${stderrTrim.embed}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!DRY) {
    fs.mkdirSync(COMPLETED_DIR, { recursive: true });
    fs.writeFileSync(path.join(COMPLETED_DIR, `${id}.md`), fmOut);
    if (sidecarPath) fs.writeFileSync(path.join(COMPLETED_DIR, sidecarPath), stdoutTrim.sidecar);
    if (stderrSidecarPath) fs.writeFileSync(path.join(COMPLETED_DIR, stderrSidecarPath), stderrTrim.sidecar);
  }
  return status;
}

function writeRejected(id, parsed, rejectedReason) {
  const { fm } = parsed;
  const out = [
    `---`,
    `id: ${id}`,
    `type: ${fm.type ?? "unknown"}`,
    `intent: ${fm.intent ?? "unknown"}`,
    `status: rejected`,
    `rejected_at: ${nowIso()}`,
    `rejected_reason: ${rejectedReason}`,
    `---`,
    ``,
    `## Original Reason`,
    ``,
    fm.reason ?? "(none)",
  ].join("\n");
  if (!DRY) {
    fs.mkdirSync(REJECTED_DIR, { recursive: true });
    fs.writeFileSync(path.join(REJECTED_DIR, `${id}.md`), out);
  }
}

function appendLog(execAt, id, type, status, durationMs, executedBy) {
  if (DRY) return;
  fs.mkdirSync(META_DIR, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(
      LOG_PATH,
      `# Action Log\n\n| executed_at | id | type | status | duration_ms | executed_by |\n|-------------|----|------|--------|-------------|-------------|\n`,
    );
  }
  fs.appendFileSync(LOG_PATH, `| ${execAt} | ${id} | ${type} | ${status} | ${durationMs} | ${executedBy} |\n`);
  // rotate
  const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n").length;
  if (lines > LOG_ROTATE_LINES) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const ym = new Date().toISOString().slice(0, 7);
    fs.renameSync(LOG_PATH, path.join(ARCHIVE_DIR, `action-log-${ym}.md`));
    fs.writeFileSync(
      LOG_PATH,
      `# Action Log\n\n| executed_at | id | type | status | duration_ms | executed_by |\n|-------------|----|------|--------|-------------|-------------|\n`,
    );
  }
}

function updateCooldown(type, status) {
  if (DRY) return;
  let cd = { version: 1, per_type: {} };
  if (fs.existsSync(COOLDOWN_PATH)) {
    try {
      cd = JSON.parse(fs.readFileSync(COOLDOWN_PATH, "utf8"));
    } catch {}
  }
  cd.per_type[type] ??= { consecutive_rejects: 0, paused_until: null };
  if (status === "rejected") {
    cd.per_type[type].consecutive_rejects += 1;
    if (cd.per_type[type].consecutive_rejects >= 3) {
      cd.per_type[type].paused_until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    }
  } else if (status === "success") {
    cd.per_type[type].consecutive_rejects = 0;
    cd.per_type[type].paused_until = null;
  }
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cd, null, 2) + "\n");
}

function notify(title, msg) {
  try {
    execSync(`osascript -e 'display notification "${msg.replace(/"/g, '\\"')}" with title "${title}"'`);
  } catch {}
}

function deletePending(file) {
  if (DRY) return;
  fs.unlinkSync(file);
}

// ----------------------------------------------------------------------------
// 一輪輪詢
// ----------------------------------------------------------------------------
function pollOnce() {
  const stamp = nowIso();
  if (!fs.existsSync(PENDING_DIR)) {
    console.log(`[${stamp}] pending dir missing — nothing to do`);
    return;
  }
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  const files = fs
    .readdirSync(PENDING_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  let executed = 0, rejected = 0, skipped = 0, stale = 0;

  for (const file of files) {
    const filePath = path.join(PENDING_DIR, file);
    const id = path.basename(file, ".md");
    const parsed = parsePendingFile(filePath);
    if (!parsed) {
      writeRejected(id, { fm: {} }, "parse_failed");
      appendLog(nowIso(), id, "unknown", "rejected", 0, "watcher-daemon");
      deletePending(filePath);
      rejected++;
      continue;
    }

    // stale 檢查
    if (parsed.fm.proposed_at) {
      const ageMs = Date.now() - new Date(parsed.fm.proposed_at).getTime();
      if (ageMs > STALE_DAYS * 24 * 3600 * 1000) {
        writeRejected(id, parsed, "stale");
        appendLog(nowIso(), id, parsed.fm.type ?? "unknown", "rejected", 0, "watcher-daemon");
        deletePending(filePath);
        stale++;
        continue;
      }
    }

    // dry_run
    if (parsed.fm.dry_run === true) {
      writeCompleted(id, parsed, { stdout: parsed.command, stderr: "", exitCode: 0, durationMs: 0 }, "watcher-daemon");
      appendLog(nowIso(), id, parsed.fm.type, "dry_run", 0, "watcher-daemon");
      deletePending(filePath);
      executed++;
      continue;
    }

    // 驗證
    const v = validate(file, parsed, allowlist);
    if (!v.ok) {
      writeRejected(id, parsed, v.reason);
      appendLog(nowIso(), id, parsed.fm.type ?? "unknown", "rejected", 0, "watcher-daemon");
      updateCooldown(parsed.fm.type ?? "unknown", "rejected");
      deletePending(filePath);
      rejected++;
      console.log(`  ✗ ${id} rejected: ${v.reason}`);
      continue;
    }

    // auto_approve 判斷
    const typeRule = allowlist.types[parsed.fm.type];
    // shell：Yen 2026-06-15 把整個 type 開成 blanket auto — app 端核准過的
    // Duffy shell action 不該再被第二道閘攔。對 shell，allowlist policy 即唯一
    // 開關，per-file `auto_approve` 變成參考（Duffy 預設 stamp false，舊的 AND
    // 邏輯會讓 policy 開關形同虛設）。其餘 type 維持雙鑰（per-file AND policy），
    // 以保住 llm_task 的 working_dir 安全檢核 — 那條檢核以 per-file auto_approve
    // 為觸發點（見 validate() §13）。deny_substrings + validate() 仍然先擋。
    const shellBlanket =
      parsed.fm.type === "shell" && typeRule.auto_approve === true;
    const effectiveAuto =
      (shellBlanket ||
        (parsed.fm.auto_approve === true && typeRule.auto_approve === true)) &&
      !v.denyHit;

    if (!effectiveAuto) {
      // 4b: 不執行、發通知、留 pending 等手動處理
      const why = v.denyHit ? `deny_substring「${v.denyHit}」命中` : "auto_approve=false";
      notify("Yen Hub Watcher", `${id} 需手動核可 (${why})`);
      console.log(`  ⏸  ${id} skipped: ${why}`);
      skipped++;
      continue;
    }

    // 4a: 執行
    const result =
      parsed.fm.type === "llm_task"
        ? execLlmTask(
            parsed.prompt,
            parsed.fm.working_dir,
            parsed.fm.max_turns ?? 10,
            parsed.fm.permission_mode,
          )
        : execCommand(parsed.command);
    const status = writeCompleted(id, parsed, result, "watcher-daemon");
    appendLog(nowIso(), id, parsed.fm.type, status, result.durationMs, "watcher-daemon");
    updateCooldown(parsed.fm.type, status);
    deletePending(filePath);
    executed++;
    const meta = result.llmMeta
      ? ` [turns=${result.llmMeta.num_turns} cost=$${result.llmMeta.total_cost_usd?.toFixed(4)}]`
      : "";
    console.log(`  ✓ ${id} ${status} (${result.durationMs}ms)${meta}`);
  }

  console.log(
    `[${stamp}] Scanned ${files.length}, executed ${executed}, rejected ${rejected}, skipped ${skipped}, stale ${stale}`,
  );
}

// ----------------------------------------------------------------------------
// 主迴圈
// ----------------------------------------------------------------------------
function main() {
  console.log(`action-watcher v0.1 ${ONCE ? "(--once)" : "(daemon)"} ${DRY ? "[DRY]" : ""}`);
  console.log(`  pending : ${PENDING_DIR}`);
  console.log(`  poll    : ${POLL_INTERVAL_MS}ms`);
  pollOnce();
  if (ONCE) return;
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

main();
