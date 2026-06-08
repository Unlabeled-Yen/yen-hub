# Yen Hub

Yen 的桌面儀表板 / 個人 OS — 把市場監看、Obsidian vault 觀察、待辦、閱讀進度、AI 教練（Duffy）整合在一個 Tauri 視窗裡。

> 個人專案、未公開。Repo 公開只是為了 AI agent 協作方便。

## 是什麼

- **單一頁面 hub**：US30 蠟燭圖、AttentionGrid（vault 活動熱圖）、ReadingProgress（書本進度立方體）、TodoList、Coach card、Duffy badge — 全部在一個 overview 裡，每天打開看一眼就掌握當下狀態。
- **Page-B**：Duffy（AI 教練）對話頁，背後是 Anthropic / Kimi 模型；有 silhouette（對使用者的描繪）、observations（vault 觀察）、summaries（週摘要）的記憶層。
- **Obsidian 整合**：直接讀 vault（透過 `YEN_VAULT_PATH`）—— 不用 plugin、不打 API；行為跟 macOS 上的 Obsidian 共生。閱讀進度立方體上點任何一本書 → 直接在 Obsidian 開到對應章節。

## 架構

```
Tauri (Rust)       ─ 視窗、IPC、URL handler、Touch ID（macOS LocalAuthentication）
   ↓ launches
Node sidecar       ─ 打包 Next.js + Node runtime，跑 http://127.0.0.1:<port>
   ↓ webview navigates to
Next.js (App Router)  ─ 前端 + API routes（vault 讀寫、chat、coach、市場資料…）
```

- Tauri 跟 Next.js 之間靠 sidecar token（Rust 啟動時 mint，URL query 帶過去，middleware 驗）
- Webview 載的是 remote（`http://127.0.0.1:*`），不是 `tauri://localhost` — 寫 Tauri capability 時要記得加 `remote.urls`（不然 release ACL 會擋 plugin IPC）
- 詳細決策見 vault 內 `06 - AI Data/Yen Hub/decisions/`（ADR）

## 技術棧

- **桌面殼**：Tauri 2，Rust edition 2021
- **前端 / API**：Next.js 16（Turbopack）、React 19、TypeScript、Motion
- **AI**：Vercel AI SDK + Anthropic / Kimi（OpenAI-compatible）
- **認證**：WebAuthn（passkey）+ macOS Touch ID
- **包裝**：Tauri sidecar 模式 — Node runtime 跟 Next.js production bundle 打進 `.app`

## 開發

```bash
pnpm install
pnpm tauri dev    # webview 自動開、Next.js hot-reload、Rust 改要 cargo rebuild
```

需要的環境變數（放 `~/.config/yen-hub/env`，**不是** `.env.local`）：

```
YEN_VAULT_PATH=/path/to/your/obsidian/vault
KIMI_API_KEY=...            # 或
ANTHROPIC_API_KEY=...
TWELVEDATA_API_KEY=...      # 市場資料
```

改 env 不用重 build；重啟 .app 就會重讀。

## Build / Ship

```bash
pnpm tauri build
```

產物：`src-tauri/target/release/bundle/macos/Yen.app`

> DMG 那一步常因為 bundle_dmg.sh 對外部依賴敏感而失敗，**`.app` 本身已經 build 好可用**，無視即可。直接拖到 `/Applications/`。

## Repo 佈局

```
app/               Next.js App Router（pages + api routes）
  hub/             主視覺 overview + page-b（Duffy 對話）
  api/             vault 讀寫、chat、coach、market、observations…
components/        React UI（reading-progress、attention-grid、todo-list、duffy badge…）
lib/
  vault/           Obsidian vault reader / writer / classifier
  agent/duffy/     Duffy 的 tools / coach / soul / memory bridge
  ai/              模型客戶端、prompt 組裝
  auth/            WebAuthn + Touch ID + session
  conversations/   對話歷史儲存
src-tauri/         Rust 殼（sidecar、auth、capabilities）
scripts/           CLI 工具，命名一律 yen- 前綴避免 shadow 系統指令
                   （yen-dev-start / yen-debug-tail / yen-app-launch…）
```

## AI 協作

- 在這個 repo 工作的 AI agent 遵守 [`CLAUDE.md`](./CLAUDE.md) 的 commit policy：
  1. AI 不主動 commit，等 Yen 說
  2. Commit 前必過 `pnpm tsc --noEmit`
  3. 每個 commit 在 HEAD 必須獨立 build 過
  4. 邏輯改動的所有檔案進同一個 commit（atomic）
  5. Commit message 寫「為什麼」不只「什麼」
- 驗證 `.app` 行為的觀察工具（log file、`/api/diag/event`、curl sidecar 等）見 `verifier-yen-hub` skill
- 權威 SPEC / ADR / Slice 文件在 Yen_Vault 的 `06 - AI Data/Yen Hub/`

## 已知限制

- macOS-only（用了 `objc2-local-authentication`、`tauri-plugin-opener` 的 macOS 行為、`window-vibrancy`）
- 未簽名、未公證 → Gatekeeper 第一次會跳「下載來源確認」
- 只在 Apple Silicon (aarch64) 上 build 測試過
