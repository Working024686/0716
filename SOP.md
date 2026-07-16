# 部屬 SOP：前端放 GitHub Pages、後端放 Render

## 1. 前端部署到 GitHub Pages

### 1.1 準備靜態前端
1. 將 `frontend/` 裡的靜態檔案放到 GitHub Pages 可服務的位置。
	- 最簡單方式：在專案根目錄新增 `docs/` 資料夾，然後把 `frontend/index.html`、`frontend/style.css`、`frontend/app.js` 等檔案複製到 `docs/`。
	- 如果有其他靜態資源（圖片、字型、assets），也一起放入 `docs/`。

### 1.2 推送到 GitHub
1. 確認專案已經初始化為 GitHub 倉庫，並且 `main` 分支已經推送到 GitHub。
2. 提交 `docs/` 資料夾內容：
	```powershell
	git add docs
	git commit -m "部署前端到 GitHub Pages"
	git push origin main
	```

### 1.3 在 GitHub 上啟用 Pages
1. 進入你的 GitHub 倉庫頁面，點選 `Settings` > `Pages`。
2. 選擇 `Branch: main`、`Folder: /docs`，然後儲存。
3. 等待 GitHub 建置並發布，成功後會看到你的 `https://<username>.github.io/<repo>/` 網址。

> 如果你想直接使用 `gh-pages` branch，也可以改成建立 `gh-pages` 分支並部署，但 `docs/` 是最簡單的作法。

### 1.4 設定後端 URL
1. 部署完成後，前端會需要指向 Render 上的後端 API。
2. 在前端頁面中，點選右上方的「系統設定」按鈕，輸入 Render 部署後的後端網址，例如：
	```text
	https://your-backend-service.onrender.com
	```
3. 儲存後即可讓前端呼叫後端 API。

## 2. 後端部署到 Render（免費方案）

### 2.1 準備 Render 專案
1. 前往 https://render.com 並登入或註冊免費帳號。
2. 點選 `New` > `Web Service`。
3. 連結到你的 GitHub 倉庫，選擇此專案。

### 2.2 選擇部署目錄
1. 如果你從 Render UI 選擇部署，請指定 `backend/` 資料夾為服務根目錄。
2. 若 Render 讀取 `render.yaml`，它會自動使用下面設定；否則手動填寫：
	- Runtime: `Python`
	- Build Command: `pip install -r requirements.txt`
	- Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`

### 2.3 設定環境變數
1. 在 Render 服務設定中新增以下環境變數：
	- `GEMINI_API_KEY`：你的 Gemini API Key（機密值，必須手動填入）。
	- `GEMINI_MODEL`：`gemini-2.5-flash`（預設值）。
	- `ALLOWED_ORIGINS`：你的 GitHub Pages 網址，例如 `https://<username>.github.io`。
	- `JWT_SECRET_KEY`：可以讓 Render 自動生成，或你自行輸入。
	- `JWT_EXPIRE_MINUTES`：`720`。
	- `DATABASE_URL`：可選。
	  - 不填則預設使用 `SQLite`（即可部署，但資料只會在同一次部署期間保留）。
	  - 若要永久保存資料，建議建立 Render Postgres，然後把連線字串填入 `DATABASE_URL`。

### 2.4 了解 SQLite 與永久資料
- `backend/database.py` 預設會使用 `sqlite:///./gear_scheduler.db`。
  Render 免費方案在重新部署時，內部檔案系統會重置，SQLite 資料庫會隨部署消失。
  若要跨部署永久保存資料，請使用 Render Postgres，並把它的連線字串填入 `DATABASE_URL`。

### 2.5 部署並測試
1. 完成設定後，觸發 Render 部署。
2. 部署成功後，打開你的後端網址，測試健康檢查：
	```text
	https://your-backend-service.onrender.com/health
	```
3. 應該會回傳：
	```json
	{"status":"ok"}
	```

## 3. 部屬完成後的測試流程
1. 先確認 Render 後端可用。
2. 確認 GitHub Pages 前端成功載入。
3. 在前端的系統設定中填入後端網址。
4. 登入測試帳號，觀察是否能正常取得工單與 AI 報告。

## 4. 常見注意事項
- 前端：GitHub Pages 只能服務靜態檔案，所有 API 呼叫必須指向 Render 後端。
- 後端：`GEMINI_API_KEY` 絕對不可放在前端，Render 的環境變數就是正確做法。
- CORS：`ALLOWED_ORIGINS` 需設為 GitHub Pages 網址，否則瀏覽器呼叫會被阻擋。
- 資料庫：若想保留資料，請用 Render Postgres 並設定 `DATABASE_URL`；否則可暫時用內建 SQLite。

## 5. 進階選項
- 若你希望前端與後端同時部署在 GitHub，亦可將 `backend/` 放到 Render、前端放到 GitHub Pages。
- 若你希望自動部署，Render 可連 GitHub 儲存庫，並在每次 `main` push 後重新部署。

---
這份 SOP 已根據此專案的 `frontend/` 靜態頁面與 `backend/render.yaml` 設定編寫。
