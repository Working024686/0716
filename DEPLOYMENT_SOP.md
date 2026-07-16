# 齒輪智慧排程系統 — 前後端分離部署 SOP（v2：正式資料庫 + FastAPI）

**架構**：前端（純靜態網頁）部署在 **GitHub Pages**，後端（FastAPI + 正式資料庫）部署在 **Render 免費 Web Service**。

```
使用者瀏覽器
   │  (打開網頁)
   ▼
GitHub Pages（index.html / app.js / style.css，純前端、免費）
   │  fetch(`${後端網址}/api/...`，夾帶 JWT)
   ▼
Render Web Service（FastAPI，Python，免費方案）
   │
   ├─ SQLite / PostgreSQL 資料庫（使用者、工單、操作紀錄、機台遙測）
   └─ 用環境變數 GEMINI_API_KEY 呼叫 → Google Gemini API
```

### 這一版跟舊版（Node/Express）差在哪裡？

| 項目 | 舊版 | 新版 |
|---|---|---|
| 後端框架 | Node.js + Express | **Python + FastAPI** |
| 使用者帳密 | 寫死在前端 `app.js`（明碼可見） | **只存在後端資料庫**，bcrypt 雜湊，前端從頭到尾看不到 |
| 工單 / 操作紀錄 | 存在瀏覽器 `localStorage`（換裝置就不見、每人各看各的） | **存在正式資料庫**，所有人、所有裝置看到同一份 |
| 身分驗證 | 無（誰都能用任何帳號登入） | **JWT**，登入才能呼叫工單/報表 API |
| AI Prompt / API Key | 前端組 Prompt，後端只單純轉發 | Prompt、機台遙測原始資料、API Key **全部只在後端**，前端只收到整理好、允許顯示的欄位 |

交付的檔案分兩包：
- **前端**：`frontend/`（`index.html`、`app.js`、`style.css`）→ 放進「前端 repo」，部署到 GitHub Pages
- **後端**：`backend/`（FastAPI 專案）→ 放進「後端 repo」，部署到 Render

建議前後端各開一個獨立的 GitHub repo（例如 `gear-scheduler-frontend`、`gear-scheduler-backend`），方便日後分開管理與部署。

---

## 前置準備

1. GitHub 帳號（<https://github.com>）
2. Render 帳號（<https://render.com>，可直接用 GitHub 帳號登入）
3. Google Gemini API Key：前往 <https://aistudio.google.com/app/apikey> → 「Create API Key」→ 複製備用

---

## Step 1｜部署後端到 Render

### 1-1　建立後端 GitHub repo

```bash
mkdir gear-scheduler-backend && cd gear-scheduler-backend
# 把交付的 backend/ 資料夾內容全部複製到這裡
# （main.py, database.py, models.py, schemas.py, security.py, seed.py,
#   routers/, requirements.txt, .env.example, .gitignore, render.yaml）
git init
git add .
git commit -m "Init FastAPI backend with database"
git branch -M main
git remote add origin https://github.com/<你的帳號>/gear-scheduler-backend.git
git push -u origin main
```

> ⚠️ 確認 `.env` 與任何 `.db` / `.sqlite3` 檔案沒有被加入（`.gitignore` 已排除），API Key 絕對不要 commit 上 GitHub。

### 1-2　在 Render 建立 Web Service

**方式 A（建議）：用 `render.yaml` 一鍵部署**
1. 登入 Render → 右上角 **New** → **Blueprint**
2. 選擇剛剛推上去的 `gear-scheduler-backend` repo，Render 會自動讀取 `render.yaml`
3. 系統會提示你補上標記為 `sync: false` 的環境變數（見下一步）

**方式 B：手動建立**
1. 登入 Render → **New** → **Web Service**
2. 選擇你的 `gear-scheduler-backend` repo
3. **Runtime** 選 `Python 3`
4. **Build Command**：`pip install -r requirements.txt`
5. **Start Command**：`uvicorn main:app --host 0.0.0.0 --port $PORT`
6. **Plan** 選 `Free`

### 1-3　設定環境變數

在 Render 服務的 **Environment** 分頁，設定：

| 變數 | 說明 |
|---|---|
| `GEMINI_API_KEY` | 你的 Gemini API Key（必填） |
| `GEMINI_MODEL` | 預設 `gemini-2.5-flash`，可留預設 |
| `ALLOWED_ORIGINS` | 你的 GitHub Pages 網址，例如 `https://<你的帳號>.github.io` |
| `JWT_SECRET_KEY` | 一組隨機長字串（若用 render.yaml 部署會自動產生） |
| `JWT_EXPIRE_MINUTES` | 登入有效時間（分鐘），預設 720 |
| `DATABASE_URL` | 留空＝用內建 SQLite（部署期間資料會保留，但**重新 deploy 會重置**）。若要跨部署永久保存，見下方「正式資料庫」說明 |

儲存後 Render 會自動重新部署。部署完成後，打開 `https://<你的服務>.onrender.com/health`，看到 `{"status":"ok"}` 就代表後端正常運作。

### 1-4（建議）加一個正式的 PostgreSQL，讓資料「真的」持久保存

Render 免費方案的檔案系統會在每次重新部署時重置，SQLite 檔案也會跟著消失、恢復成種子資料。若這套系統要正式上線使用，建議：

1. Render → **New** → **PostgreSQL**（有免費額度）
2. 建立完成後，複製它的 **Internal Database URL**
3. 貼到後端服務的環境變數 `DATABASE_URL`
4. 重新部署 — 完全不用改任何程式碼，SQLAlchemy 會自動切換到 PostgreSQL

---

## Step 2｜部署前端到 GitHub Pages

### 2-1　設定後端網址

打開 `frontend/app.js`，找到：

```js
const DEFAULT_BACKEND_URL = 'https://YOUR-RENDER-APP-NAME.onrender.com';
```

換成你在 Step 1 拿到的 Render 服務網址（也可以不改，部署後在網頁右上角 ⚙️ 設定裡填也可以）。

### 2-2　建立前端 GitHub repo 並開啟 Pages

```bash
mkdir gear-scheduler-frontend && cd gear-scheduler-frontend
# 把交付的 frontend/ 資料夾內容（index.html, app.js, style.css）複製到這裡
git init
git add .
git commit -m "Init frontend"
git branch -M main
git remote add origin https://github.com/<你的帳號>/gear-scheduler-frontend.git
git push -u origin main
```

到 GitHub repo → **Settings** → **Pages** → Source 選 `main` branch、`/ (root)` → Save。
幾分鐘後即可在 `https://<你的帳號>.github.io/gear-scheduler-frontend/` 打開系統。

### 2-3　回頭把前端網址填回後端的 `ALLOWED_ORIGINS`

到 Render 後端服務的 Environment，把 `ALLOWED_ORIGINS` 設成你的 GitHub Pages 網址（可用逗號分隔多個），例如：

```
https://<你的帳號>.github.io
```

儲存後 Render 會自動重新部署，CORS 才會正確放行前端的請求。

---

## Step 3｜測試

1. 打開前端網址 → 右上角 ⚙️ → 確認後端網址已填好 → 儲存
2. 用測試帳號登入：`EMP-808 / 808`（主管）、`EMP-101 / 101`（生管）、`EMP-202 / 202`（領班）
3. 確認看板能讀到工單資料（來自資料庫，不是瀏覽器暫存）
4. 進「插單模擬評估」跑一次 AI 分析與決策報告，確認 Gemini 呼叫正常
5. 換一台裝置 / 換一個瀏覽器登入同一組帳號，確認看到的工單與操作紀錄是同一份（證明資料真的存在資料庫，而不是各自瀏覽器的 localStorage）

---

## 正式上線前的安全檢查清單

- [ ] `JWT_SECRET_KEY` 已換成隨機字串，不是預設值
- [ ] `ALLOWED_ORIGINS` 已設成明確網址，沒有留 `*`
- [ ] 已幫三個測試帳號（EMP-808 / EMP-101 / EMP-202）換成正式密碼
- [ ] 已接上正式 PostgreSQL（`DATABASE_URL`），不是只靠免費方案的暫存 SQLite
- [ ] `.env`、`*.db` 檔案都沒有出現在任何 GitHub repo 裡
