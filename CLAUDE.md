# Yen Hub — AI 協作規約

> Tauri (Rust) + Next.js sidecar 的桌面 app。權威 SPEC / ADR / Slice 文件在
> Yen_Vault 的 `06 - AI Data/Yen Hub/`，AI 工作前先讀過。

## Git Commit Policy（重要：AI 必讀）

過去經驗：AI 邊做邊主動 commit 造成「commit 看起來漂亮，但每個 commit 在
當下其實是壞的 / 不完整的」。例如改 reader 簽名、commit 了 reader 跟 2 個
caller，但漏了第 3 個 caller，結果歷史中那個 commit 在 HEAD checkout 時根本
build 不過。

為了不再重蹈覆轍，AI 在這個 repo 工作時遵守以下規則：

### 規則 1：AI 永遠不主動 commit
- AI 改完代碼後**停下來**，不自動 `git commit`
- 等 Yen 明確說「commit」、「先存一下」、「push 吧」之類的指令才動手
- 這把封存時機的控制權還給 Yen，他知道什麼時候測過了、什麼時候可以鎖

### 規則 2：Commit 前必過 verification gate
任何 commit（不管 AI 提議還是 Yen 發起）執行前，AI 先跑：

```bash
pnpm tsc --noEmit
```

過了才 stage 才 commit。型別錯就先修，不修就不 commit。

可選但推薦：跑 `pnpm build` 或請 Yen 開 `.app` 戳一下，確認 runtime 也活著。

### 規則 3：每個 commit 必須在 HEAD 獨立 work
寫進 commit message 前，AI 心裡（或對 Yen）問一句：
> 「現在 checkout 這個 commit，build 會過嗎、`.app` 會開嗎？」

- 會 → 可以 commit
- 不會 → 邏輯單位還沒結束，繼續改
- 不確定 → 跑 verification gate 再說

### 規則 4：Atomic 邊界 — 一個邏輯改動的所有檔案進同一個 commit
改 `lib/X.ts` 的 function 簽名 → 所有 callers 必須在同一個 commit 裡更新。
不能「先 commit X，下個 commit 再補 callers」— 那個中間狀態的 commit 是壞的。

如果發現一個邏輯改動跨太多檔，**不是拆 commit，是縮小邏輯改動**。

### 規則 5：Commit message 寫「為什麼」不只「什麼」
- ❌ `update reader.ts`（什麼，沒用）
- ✅ `fix(vault/reader): handle empty frontmatter to stop Duffy crash on new files`（為什麼）

格式建議（不強制）：`<type>(<scope>): <summary>`
type: `feat` / `fix` / `refactor` / `perf` / `style` / `chore` / `wip`

## 其他

- 編輯 markdown 跟 Obsidian 規約對齊 → 看 Yen_Vault 的 `CLAUDE.md`
- 改 Tauri 設定 / sidecar 架構 → 先讀 `06 - AI Data/Yen Hub/` 下的 ADR
- 驗證 .app 行為 → 用 `verifier-yen-hub` skill 提供的觀察工具（log、diag）
