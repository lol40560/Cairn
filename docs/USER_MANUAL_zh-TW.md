# Cairn 使用手冊

> 適用版本：Cairn 2.0.2
> 更新日期：2026 年 10 月 21 日
> 授權：MIT License

Cairn 是一套 **local-first（本機優先）** 的桌面協作工具，協助開發者與 AI coding agent 看懂專案內的檔案變化、發現同檔案的重疊工作、進行點對點協作，並在需要時從 checkpoint 或已刪除檔案中復原。

它不是雲端 IDE、Git 的替代品，也不會自動把工作上傳到 Cairn 的伺服器；Cairn 沒有自營帳號、雲端同步、分析或遙測服務。

---

## 目錄

1. [開始前的重要事項](#開始前的重要事項)
2. [安裝與首次開啟](#安裝與首次開啟)
3. [介面導覽](#介面導覽)
4. [專案與首頁](#專案與首頁)
5. [變更、差異與衝突](#變更差異與衝突)
6. [檔案瀏覽與內建編輯器](#檔案瀏覽與內建編輯器)
7. [編輯宣告：人類與 AI agent 協作](#編輯宣告人類與-ai-agent-協作)
8. [團隊與點對點協作](#團隊與點對點協作)
9. [復原：checkpoints 與已刪除檔案](#復原checkpoints-與已刪除檔案)
10. [GitHub 匯出](#github-匯出)
11. [設定與鍵盤快捷鍵](#設定與鍵盤快捷鍵)
12. [資料、隱私與安全](#資料隱私與安全)
13. [技術架構](#技術架構)
14. [開發、測試與打包](#開發測試與打包)
15. [疑難排解](#疑難排解)
16. [限制與最佳實務](#限制與最佳實務)

---

## 開始前的重要事項

### Cairn 適合做什麼

- 追蹤本機專案資料夾中的檔案新增、修改與刪除。
- 瀏覽依檔案或工作階段整理的變更紀錄與 diff。
- 與同一房間內、可互相連線的隊友協作。
- 在人類與 AI agent 之間宣告「我正在改這個檔案」，減少互相覆蓋。
- 建立 checkpoint、檢視衝突、還原已刪除檔案。
- 在確認後把變更匯出為 GitHub Pull Request。

### Cairn 不應取代什麼

- Git、遠端 repository、正式 code review。
- 外部備份與版本控制策略。
- 對完整專案同步結果的保證；Cairn 目前不提供「所有對等端已完整收斂」的協定級證明。

### 目前發行版本的簽署提醒

目前 2.0.1 安裝檔為**未簽署**版本。macOS Gatekeeper 或 Windows SmartScreen 可能提出警告。請僅從官方 [GitHub Releases](https://github.com/lol40560/Cairn/releases) 下載，並在安裝前確認檔案名稱、版本與 SHA-256 校驗資訊。

---

## 安裝與首次開啟

### macOS

1. 下載對應處理器架構的 `.dmg`：Apple Silicon 使用 `arm64`；Intel Mac 使用一般 macOS 檔案。
2. 開啟 `.dmg`，將 **Cairn.app** 拖到 **Applications**。
3. 第一次開啟時，若 macOS 顯示安全警告，請確認下載來源與 checksum。
4. 若系統沒有顯示「仍要打開」選項，請先不要信任未知檔案；重新從 GitHub release 下載並核對版本後，再依 macOS 的安全設定操作。

### Windows

1. 下載 `Cairn-Setup-<version>.exe`。
2. 執行安裝程式；它允許選擇安裝位置並建立桌面或開始選單捷徑。
3. 未簽署版本可能出現 SmartScreen 提示。確認來源正確後再繼續。

### 第一次使用

1. 開啟 Cairn。
2. 在專案庫中選擇或加入本機資料夾。
3. Cairn 會啟動檔案監控並建立專案內的 `.cairn/` 資料。
4. 進入專案 dashboard 後，可前往「變更」、「檔案」、「團隊」或「復原」工作區。

> 建議：第一次先在小型、非關鍵專案試用。Cairn 適合監看最多約 2,000 個檔案的工作區；檔案過多時請改選較小的子資料夾。

---

## 介面導覽

### 專案切換器

頂部的專案名稱與下拉箭頭可開啟專案切換器。它會列出：

- **Home／專案庫**：回到所有最近專案。
- **Recent projects／最近專案**：切換至另一個已加入的工作區。

移除最近專案只會移除 Cairn 的清單項目，**不會刪除磁碟上的資料夾或檔案**。

### 側邊欄

開啟專案後，側邊欄提供以下主要區域：

| 區域 | 用途 |
| --- | --- |
| Home | 查看近期活動、專案狀態與摘要。 |
| Changes／變更 | 檢視已觀察到的檔案變動。 |
| Files／檔案 | 瀏覽專案樹、閱讀與編輯文字檔。 |
| Team／團隊 | 建立或加入點對點協作房間。 |
| Same-file edits／同檔案編輯 | 檢視潛在重疊與已確認衝突。 |
| Checkpoints | 建立、比較、還原專案快照。 |
| Deleted files | 復原保留期間內被刪除的檔案。 |
| Settings | 設定協作保護、GitHub 與應用程式偏好。 |

---

## 專案與首頁

### 加入專案

1. 在專案庫選擇新增或開啟專案。
2. 選擇一個本機絕對路徑資料夾。
3. Cairn 會檢查可讀性與檔案數量，然後開始監控。

監控期間的新增、修改和刪除會被記錄為操作紀錄（operation history）。敏感檔案、二進位檔與部分常見依賴／建置目錄會被排除，不會在內建檔案瀏覽器中顯示。

### Home dashboard

Home 用於快速掌握：

- 最近變更量與活動趨勢。
- 本機監控是否正常。
- 團隊同步與 peer 連線狀態。
- 最近使用的檔案與復原工具入口。

它是專案概覽，不會取代「變更」頁面的完整 diff 與篩選功能。

---

## 變更、差異與衝突

### 檢視變更

「變更」頁面會將檔案操作整理成工作階段，並提供：

- **Grouped／Raw**：依工作階段或原始操作檢視。
- **All／Mine／Team**：篩選全部、本機或團隊相關變更。
- 搜尋檔案名稱。
- 每個檔案的新增／刪除行數統計。
- 點開後檢視 diff。

### 潛在重疊與已確認衝突

- **潛在重疊**：多人在相近時間改到同一檔案，Cairn 提醒你留意，但不代表內容一定無法合併。
- **已確認衝突**：遠端變更無法安全套用時，Cairn 保留衝突內容，讓你選擇本機版本、遠端版本或手動合併結果。

若目前在內建編輯器有未儲存內容，請先儲存或捨棄，再處理會覆蓋該檔案的衝突。

---

## 檔案瀏覽與內建編輯器

### 開啟檔案

在「檔案」頁面：

1. 使用左側搜尋框找檔案。
2. 從資料夾樹選取文字檔。
3. Cairn 使用 Monaco Editor 顯示內容與語法高亮。

為了安全與效能，Cairn 不會在內建編輯器開啟：

- 超過 1 MB 的文字檔。
- 偵測為二進位的檔案。
- 被識別為敏感的檔案。
- 符號連結逃出專案根目錄的路徑。

### 儲存

- 使用右上角 **Save**。
- 或按 `Cmd/Ctrl + S`。

儲存後，Cairn 的 watcher 會把這次實際磁碟變更納入活動紀錄。若檔案正被其他有效 edit claim 保護，行為取決於專案的軟鎖／嚴格模式設定。

---

## 編輯宣告：人類與 AI agent 協作

編輯宣告（Edit Claim）是 Cairn 的檔案層級協作保護。它的目標是讓每個人知道「誰正在改哪個檔案、為什麼改」，降低人類和 AI agent 同時覆蓋同一份內容的風險。

### 基本規則

- Claim 的預設租約是 **10 分鐘**。
- 工作中的持有人會每 2 分鐘送 heartbeat，持續延長租約。
- 完成後應按 **完成編輯** 釋放 claim。
- 沒有 heartbeat 的 claim 到期後會自動變成 expired，不會永久卡住專案。
- 只有 claim 持有人與專案擁有者可以釋放 claim。

### 人類使用者的流程

1. 在檔案編輯器開始輸入時，Cairn 為目前檔案建立 claim。
2. 檔案樹會出現綠色狀態點；其他人 hover 可看到持有人。
3. 檔案頁面會顯示協作訊息，例如「某位使用者正在編輯」或「已完成編輯」。
4. 工作結束後，按 **完成編輯**。

### AI agent 必須遵守的流程

AI agent 修改任何專案檔案前必須：

1. 查詢 active claims。
2. 列出它打算修改的檔案。
3. 若目標檔案已有其他 owner 的 active claim，**停止寫入**。
4. 透過 Cairn 告知使用者衝突位置、持有人與原本工作意圖，等待指示。
5. 沒有衝突時，建立自己的 claim；工作中定期 heartbeat；完成時釋放。

完整協定見 [`docs/skills/cairn-edit-claims.md`](./skills/cairn-edit-claims.md)。

### 軟鎖與嚴格模式

| 模式 | 行為 |
| --- | --- |
| 軟鎖（預設） | 顯示警告與協作事件；使用者仍可決定是否儲存。AI agent 必須停止並向使用者回報。 |
| 嚴格編輯保護 | Cairn 會拒絕透過內建編輯器寫入其他 owner 有效 claim 的檔案。 |

在 **Settings → Collaborative edit claims → Strict edit protection** 可開啟或關閉嚴格模式。

### 房間同步

加入同一 Cairn room 的 peer 會透過既有的已驗證、加密通道接收 claim 事件。新加入的 peer 也會收到目前仍有效的 claims。

> 重要：外部編輯器或沒有安裝／遵守 Cairn skill 的工具無法被強制約束。嚴格模式只會保護透過 Cairn 內建寫入流程進行的儲存。

---

## 團隊與點對點協作

### 建立團隊

1. 開啟 **Team**。
2. 選擇 **Start a team**。
3. Cairn 產生房間邀請碼。
4. 用安全方式分享邀請碼給可信任的隊友。

### 加入團隊

1. 開啟 **Team**。
2. 選擇 **Join a team**。
3. 輸入邀請碼。
4. 選擇下載／使用專案的目標資料夾。

### 自動探索與直接連線

同一可到達的 Wi‑Fi 或 hotspot 上，Cairn 可使用 mDNS 尋找相容 peer。若公司、校園網路、VPN 或 guest Wi‑Fi 封鎖裝置間通訊：

1. 請 host 在 Team 頁面查看 `IP:port`。
2. 由 joiner 使用 direct connection 輸入 host、port 與邀請碼。
3. 確認兩端防火牆都允許 Cairn 的本機網路連線。

### 安全模型

- 邀請碼是高熵的 128-bit Base32 room secret；不要公開貼在 issue、截圖或聊天室。
- mDNS discovery 不會廣播 room secret。
- peer 資料經驗證後使用加密傳輸。
- 只與你信任的人及裝置協作；加入房間代表對方可能收到協作所需的專案內容與變更資訊。

---

## 復原：checkpoints 與已刪除檔案

### 建立 checkpoint

在進行大規模重構、接受 AI 大量修改、還原衝突前，先建立 checkpoint。

1. 進入 **Checkpoints**。
2. 選擇建立 checkpoint，可填寫名稱。
3. Cairn 建立可比較、可還原的專案快照。

### 比較與還原

- 先比較 checkpoint 與目前工作區，確認新增、修改、刪除的內容。
- 還原前，Cairn 會先建立復原前 checkpoint，減少誤操作不可逆的風險。
- 若存在未儲存的內建編輯器內容，先處理它們再進行還原。

### 已刪除檔案

Cairn 對觀察到的刪除建立本機 recovery 資料。可在 **Deleted files**：

- 檢視刪除時間、原始路徑與大小。
- 還原指定檔案。
- 永久清除單一項目或清空保留區。

預設保留期為 30 天，可在 Settings 調整為 1–365 天。

> Checkpoint 與 deleted-file recovery 是便利的復原功能，不是備份系統。重要資料請維持 Git commit、遠端 repository 或外部備份。

---

## GitHub 匯出

GitHub 功能是選用且使用者主動觸發的功能。

### 設定

1. 前往 **Settings → GitHub**。
2. 輸入 GitHub token、owner 和 repository。
3. 儲存設定。

Token 以 Electron `safeStorage` 使用作業系統提供的保護機制儲存在本機；不要把 token 放進專案檔、聊天室或截圖。

### 建立 Pull Request

1. 確認目前專案與欲匯出的檔案正確。
2. 開啟匯出 PR 的功能。
3. 填寫 title、內容與 branch 資訊。
4. 確認後，Cairn 才會呼叫 GitHub API、建立 branch／PR。

請在送出前確認你有權分享該專案內容，並確認目標 owner、repo 與 branch。

---

## 設定與鍵盤快捷鍵

### 設定

| 設定 | 說明 |
| --- | --- |
| 重新查看引導 | 再次開啟第一次使用流程。 |
| 產品導覽 | 顯示互動式介面導覽。 |
| 嚴格編輯保護 | 阻擋內建編輯器寫入他人有效 claim 的檔案。 |
| Deleted files 保留期 | 設定 1–365 天。 |
| GitHub | 設定 token 與目標 repository。 |
| 隱私與授權 | 檢視 privacy policy、第三方授權與 GitHub repository。 |

### 快捷鍵

| 動作 | macOS | Windows／Linux |
| --- | --- | --- |
| Quick Open | `Cmd + P` | `Ctrl + P` |
| Command Palette | `Cmd + K` | `Ctrl + K` |
| 儲存目前檔案 | `Cmd + S` | `Ctrl + S` |
| Home、Changes、Files、Team、Conflicts | `Cmd + 1–5` | `Ctrl + 1–5` |
| Settings | `Cmd + ,` | `Ctrl + ,` |

---

## 資料、隱私與安全

### 本機儲存

Cairn 會在專案內 `.cairn/` 儲存操作歷史、同步／復原資料、trash 與 edit claims 等專案資料。應用程式層級設定、最近專案與 GitHub 設定則保留在作業系統的 app data 位置。

請勿手動修改 `.cairn/` 內的 JSON、操作資料或 recovery 資料，除非你已先備份並瞭解影響。

### 不會自動收集的資料

Cairn 沒有 Cairn 自營的：

- 帳號服務。
- 雲端儲存或同步後端。
- 使用分析與 telemetry 管線。
- 自動上傳的診斷服務。

### 何時資料會離開你的電腦

| 動作 | 可能傳送的資料 |
| --- | --- |
| 建立或加入 Cairn room | 協作所需的專案內容、操作與 claim 資料，直接傳給授權 peer。 |
| 本機網路探索 | 服務、peer、協定與網路 metadata；不包含邀請碼。 |
| GitHub 匯出 | 該次 PR／export 所需的 repository 識別、憑證與專案內容。 |
| 手動複製診斷資料 | 只有你自行貼到其他服務時才會離開裝置。 |

詳細內容請見 [PRIVACY.md](../PRIVACY.md) 與 [TERMS.md](../TERMS.md)。

---

## 技術架構

### 技術堆疊

| 層級 | 技術 | 用途 |
| --- | --- | --- |
| 桌面容器 | Electron 44 | 原生桌面視窗、IPC、safeStorage、系統整合。 |
| UI | React 19 + TypeScript | 介面、狀態與元件。 |
| Build | electron-vite / Vite | renderer、main、preload 編譯。 |
| 編輯器 | Monaco Editor | 檔案預覽、語法高亮與編輯。 |
| 本機資料 | better-sqlite3、JSON 與 `.cairn/` | 操作歷史、專案資料與設定。 |
| 檔案監控 | chokidar | 偵測本機檔案變化。 |
| P2P discovery | bonjour-service / mDNS | 在本機網路發現 peer。 |
| P2P 傳輸 | Node.js TCP + authenticated encrypted transport | 房間協作、同步、claims。 |
| Diff／合併 | diff、node-diff3 | 顯示差異與協助衝突處理。 |
| GitHub | Octokit | 使用者要求時建立 PR。 |
| 測試 | Vitest | 單元與 IPC 測試。 |

### 執行流程

```text
Renderer（React）
       │ 受限 IPC（preload contextBridge）
       ▼
Electron main process
       ├── 檔案 watcher / 操作歷史 / checkpoints / trash
       ├── 編輯宣告與協作事件
       ├── GitHub export
       └── 已驗證加密 P2P sync
                │
                ▼
           已授權 peer
```

### 安全邊界

- Renderer 不直接讀寫任意檔案；檔案操作由 main process 驗證路徑後執行。
- IPC 只接受目前主視窗 main frame 的可信呼叫。
- 專案內的符號連結逃逸、絕對路徑與敏感檔案會被拒絕。
- 傳輸訊息有大小限制，避免不受控的記憶體使用。
- GitHub token 使用 OS-backed Electron safeStorage（可用時）。

---

## 開發、測試與打包

### 需求

- Node.js 22 以上。
- npm。
- 對應平台的編譯工具；`better-sqlite3` 是原生相依套件。

### 取得原始碼

```bash
git clone https://github.com/lol40560/Cairn.git
cd Cairn
npm install
npm run dev
```

### 常用指令

```bash
npm test                 # 執行測試
npm run lint             # ESLint
npx tsc -b --pretty false # TypeScript 檢查
npm run build            # production build
npm run verify:sync      # 同步機制驗證
npm run verify:legal     # 驗證法律文件產物
npm run dist:mac         # 在 macOS 打包
npm run dist:win         # 在 Windows 打包
```

### 發行建議流程

1. 確認 `package.json` 的版本、README、CHANGELOG 與 RELEASE_NOTES 一致。
2. 執行測試、lint、typecheck、build 與 release 文件驗證。
3. 建立 commit 與 `v<version>` tag。
4. 由 GitHub Actions 建置 macOS 與 Windows artifacts。
5. 確認 SHA-256 manifest、release notes、檔案名稱與 installer 是否正確。
6. 若未做簽署，清楚標示 unsigned 狀態；不要宣稱已 notarize 或已通過 SmartScreen reputation。

---

## 疑難排解

### 看不到變更

1. 確認目前專案資料夾是否正確。
2. 檢查 Cairn 是否處於追蹤中狀態。
3. 確認變更不是在被忽略的目錄、二進位檔或敏感檔中。
4. 對外部工具的大量／極快寫入，等待短暫時間讓 watcher 完成事件整理。
5. 仍無結果時，停止並重新開始監控該專案。

### 隊友無法找到房間

1. 確認雙方使用相同邀請碼。
2. 確認在可互相連線的網路上。
3. 關閉或調整阻擋裝置間流量的 VPN、guest Wi‑Fi 或企業網路設定。
4. 使用 Team 頁面的 direct connection，輸入 host 的 IP、port 與邀請碼。
5. 檢查系統防火牆是否允許 Cairn。

### 儲存被拒絕

- 若啟用了嚴格編輯保護，表示另一個使用者或 agent 有該檔案的 active claim。
- 在檔案樹與協作訊息中確認持有人。
- 請持有人完成／取消工作，或由專案擁有者解除 stale claim。
- 若你是 agent，請停止修改並請使用者決定，不要繞過 claim。

### Claim 看起來卡住

- 等待最長 10 分鐘讓沒有 heartbeat 的 claim 過期。
- 請原持有人按「完成編輯」。
- 專案擁有者可解除 claim。
- 若 peer 已離線，確認它沒有重新連線後繼續工作。

### 無法復原檔案

- 確認檔案仍在設定的保留期內。
- 確認你沒有先永久清除該 deleted-file 項目。
- checkpoint／trash 不是外部備份，若資料不在 Cairn 的保留資料中，請從 Git、Time Machine、檔案歷史紀錄或備份服務復原。

### GitHub 匯出失敗

1. 確認 token 格式與權限。
2. 確認 owner、repository 與網路連線。
3. 確認該 token 對目標 repository 有建立 branch／PR 的權限。
4. 到 Settings 清除後重新設定 token；不要把 token 貼到 issue。

---

## 限制與最佳實務

### 已知限制

- Cairn 尚未提供跨 peer 的完整收斂確認。
- session-level rollback 目前不是自動三方 revert 功能。
- 二進位檔案僅能顯示 metadata，沒有視覺化內容 diff。
- 區段／函式層級的 edit claim 尚未實作；目前是檔案層級。
- edit claim 無法阻止沒有遵守 Cairn 協定的外部編輯器或 agent。

### 建議工作方式

1. 大型修改前先建立 checkpoint。
2. 讓每個 AI agent 在開始前列出目標檔案並建立 claim。
3. 遇到同一檔案工作時，先分配工作、拆分檔案或等待完成，不要平行硬改。
4. 對重要變更保留 Git branch、commit 與遠端備份。
5. 不要分享 room secret、GitHub token 或含敏感資料的 diagnostics。
6. 在正式團隊使用前，先於小型測試專案驗證網路、權限與復原流程。

---

## 相關文件與支援

- [README](../README.md)
- [架構文件](../ARCHITECTURE.md)
- [UI 設計說明](../UI.md)
- [Privacy Policy](../PRIVACY.md)
- [Terms of Use](../TERMS.md)
- [第三方授權](../THIRD_PARTY_NOTICES.md)
- [GitHub Issues](https://github.com/lol40560/Cairn/issues)

Cairn 依 MIT License 提供，不附保證。請在使用前評估你的專案、網路、資料備份與協作風險。
