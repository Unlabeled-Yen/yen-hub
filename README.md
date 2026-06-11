# Yen Hub

> 一個給知識工作者的桌面儀表板。把市場、閱讀、寫作、待辦、AI 對話收進同一個視窗，每天打開就掌握當下狀態。

![Yen Hub welcome screen](docs/screenshots/01-welcome.webp)

---

## 這是什麼

**Yen Hub 是一個整合型的個人工作中樞 (personal hub)。**

現代知識工作者的工具是散落的：看盤要切到券商 App，追書進度在 Obsidian / Kindle，待辦在 Notion，AI 對話在 ChatGPT 視窗，寫作筆記又在另一個地方。每天一早，光是「看一遍所有要看的東西」就要切換四五個應用程式。

Yen Hub 把這些都收進**一個視窗**。打開就是當天的全景：US30 走勢、最近在讀什麼書讀到哪、今天的待辦、AI 教練（Duffy）對使用者的觀察與建議。不需要切換應用程式，不需要重新進入工作狀態。

它不是要做「另一個 Notion」、也不是要取代任何工具。它做的是**把現有工具的訊號集中起來**，讓使用者每天節省 15 分鐘的「找東西時間」、不再因為切換應用程式打斷思緒。

---

## 主畫面總覽

![Yen Hub overview — market chart, reading progress, todos](docs/screenshots/02-overview.webp)

一個畫面四個區塊，對應一天裡最常回頭看的訊號：

| 區塊 | 內容 | 為什麼放在這 |
|---|---|---|
| **市場監看**（上） | US30 / YM1! 蠟燭圖 + ATR / RVOL 量能統計 | 開盤瞄一眼就知道波動性 |
| **注意力直方圖**（左上） | 過去 7 天 vault 各區的「讀 / 寫 / AI 建造」活動 | 提醒今天的時間配置：該寫作了嗎？ |
| **閱讀進度立方體**（左下） | 在讀的書，書名 / 作者 / 進度 / 看到哪章 | 立方體可滑動翻面看不同批次；**點一本書直接跳到 Obsidian 對應章節** |
| **總覽代辦**（右下） | 從 vault 抓出來的待辦，分群顯示 | 勾掉直接寫回 vault |
| **Duffy 教練**（左上角） | AI 教練 badge，點開進入對話頁 | 背後有長期描繪（silhouette）、週摘要、跨對話記憶 |

---

## Duffy 副駕

內建的 AI 副駕。不只是聊天視窗——他能 observe、規劃、動 vault、自動排提醒，且會學使用者的授權範圍。

| 使用者做什麼 | Duffy 做什麼 |
|---|---|
| 隨口講「明天下午 1 點提醒看診」 | 排成一條 cron schedule、觸發時推 macOS 通知 + Telegram |
| 隨口提到一個觀察 | 寫入 observations 並鏡像到 `06 - AI Data/Observations/` |
| 問「最近 git 怎樣」 | `git_status` / `git_log` / `git_diff` 等白名單沙箱命令 |
| 想動 vault 檔 | 走 propose-approve、看一張卡片、通過才真的寫 |

### 信任分層（Adaptive Trust）

不是所有提案都該打斷使用者。Duffy 的提案有三層：

| 層 | 範例 | 「平衡」模式下行為 |
|---|---|---|
| **L0**（低風險） | 寫一條觀察 | 自動執行、24h 內可撤銷 |
| **L1**（中） | 建新檔、新排程、週摘要 | 跳一張審批卡 |
| **L2**（不可逆） | 改既有檔、更新剪影 | 永遠要使用者批 |

三檔旋鈕在 page-b 的 04 信任分層：**謹慎**（全部要批）/ **平衡**（L0 自動）/ **奔放**（L0+L1 自動）。預設謹慎。

### 自適應信任：Duffy 會學

每次 approve / reject 都被記為訊號。累積到 ≥90% 通過率、Duffy 會在 banner 主動提案：「過去 30 天觀察通過 58/60，要不要升為自動？」使用者拍板。進階開關 **Auto-pilot** 打開後、Duffy 自己升降 tier、每次調整寫 audit log、可隨時關掉。

### Telegram 雙向對話

設定一個 BotFather 建的 Telegram bot，Yen Hub 後端長輪詢、訊息走 chat_id 白名單。使用者不在 Mac 前也能跟 Duffy 對話、提醒觸發時也會推 Telegram。需要 Yen Hub 持續運行（macOS 醒著、.app 不關）。

---

## 設計選擇

每一個細節都是從「使用者自己每天要用」出發——不是先想功能再找需求。

- **閱讀進度做成 3D 立方體**：書多到一個畫面塞不下，但不想做成 list 失去全景感。立方體四面塞得下 32 本，左右滑翻面。每本同時看得到進度、最遠讀到哪章。
- **「處理過 N 章」vs「看到第 N 章」**：AI 翻譯處理過、但使用者自己還沒讀的書，用不同顏色標。避免「進度 90% 但其實沒讀」的假象。
- **點書直接開 Obsidian**：閱讀立方體不只是儀表板，也是入口。看到哪本最近沒進度想繼續讀，點一下就跳到上次讀到那章。
- **Duffy 不搶版面**：AI 不是塞滿視窗的主角，是「需要時叫得到」的角色。badge 平常呼吸，有想說的話會跳訊息。
- **配色與背景**：深色基底、奶油色字體、低彩度，搭個人風格的背景圖。每天看的東西，視覺疲勞比資訊密度更該優先處理。

---

## 開發方式

這個 app 的程式碼是和 AI（Claude Code）密集協作寫的。使用者本身沒有工程背景。

分工是：

- **使用者**：定義要做什麼、定義成功的樣子、做設計決策、判斷成品對不對、踩坑時主動觀察並引導 debug
- **AI**：把需求翻譯成程式、提案技術路線、寫程式、解釋每個決策的取捨

過程中累積了一套驗證流程：每次 AI 提案 → 在實機上跑 → 用 log 觀察行為 → 不靠直覺判斷對錯 → 把每一次踩坑寫成可重用的知識（見 [`DEVELOPING.md`](./DEVELOPING.md)）。

整個專案下來最有價值的不是這個 app，而是這套流程本身：不會寫程式的人，可以擔任產品的最終決策者，把腦中的工具做出來。

---

## 技術組成

- 桌面殼：Tauri 2（Rust）
- 前端：Next.js 16 + React 19 + TypeScript
- AI：Claude（Anthropic）+ Kimi，透過 Vercel AI SDK
- 認證：WebAuthn / 點擊式（Mac 解鎖即可進入）
- 持久化：JSON store（`~/Library/Application Support/com.yen.hub/`、單檔案 + 行式 JSONL audit log）
- 對外整合：macOS notification（osascript）、Telegram Bot API（long-poll）
- 資料來源：Obsidian vault（檔案系統直讀）、TwelveData（市場資料）

架構決策、開發流程、踩坑紀錄見 [`DEVELOPING.md`](./DEVELOPING.md)。

---

## 已知限制

- 只支援 macOS（Apple Silicon）
- 個人工具，沒有公開發行；repo 公開是為了 AI 協作方便
- 未簽署 / 公證 → 第一次打開系統會跳防護提示
- Telegram 雙向對話需要 .app 開著、Mac 醒著（長輪詢、無公網 webhook）
- 提醒類 cron 觸發時的「missed-fire 補打」對「明天下午 X 點」這種單次語意還不完美——若 Mac 在指定時間後才開機、會立刻補打一次（已記入後續微調）
