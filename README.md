# 0716 Deployment Guide

這個專案已經包含：

- `frontend/`：純靜態網站，適合部署到 GitHub Pages
- `backend/`：FastAPI 後端，適合部署到 Render
- `backend/render.yaml`：Render 的服務設定檔，包含 build/start 命令與環境變數定義

## 1. 後端部署到 Render

1. 在 GitHub 建立後端 repo，例如 `0716-backend`
2. 進入 `backend` 資料夾：

```powershell
cd backend
git init
git add .
git commit -m "Init FastAPI backend"
git branch -M main
git remote add origin https://github.com/Working024686/0716-backend.git
git push -u origin main
```

3. 登入 Render，建立新的 Web Service：
   - 如果使用 Blueprint，Render 會讀取 `backend/render.yaml`
   - Build Command：`pip install -r requirements.txt`
   - Start Command：`uvicorn main:app --host 0.0.0.0 --port $PORT`

4. 在 Render 服務的 Environment 中設定：
   - `GEMINI_API_KEY`：你的 Gemini API Key
   - `GEMINI_MODEL`：`gemini-2.5-flash`
   - `ALLOWED_ORIGINS`：你的 GitHub Pages 網址，例如 `https://<你的帳號>.github.io`
   - `JWT_SECRET_KEY`：可以由 Render 自動產生，或填一組長字串
   - `JWT_EXPIRE_MINUTES`：`720`
   - `DATABASE_URL`：如果想持久化資料庫，請設定 Render PostgreSQL 的連線字串；不設定則會使用暫存 SQLite

5. Render 部署完成後，確認後端網址可連線，例如 `https://<your-service>.onrender.com`。

## 2. 前端部署到 GitHub Pages

1. 在 GitHub 建立前端 repo，例如 `0716-frontend`
2. 進入 `frontend` 資料夾：

```powershell
cd frontend
git init
git add .
git commit -m "Init frontend"
git branch -M main
git remote add origin https://github.com/Working024686/0716-frontend.git
git push -u origin main
```

3. 到 GitHub repo → Settings → Pages → Source 選 `main` branch、`/ (root)` → Save。
4. 幾分鐘後，你的網站會出現在 `https://<你的帳號>.github.io/0716-frontend/`。

## 3. 前端後端串接設定

- 打開 `frontend/app.js`
- 將 `DEFAULT_BACKEND_URL` 改成你的 Render 後端網址，例如：

```js
const DEFAULT_BACKEND_URL = 'https://your-render-service.onrender.com';
```

- 在 Render 後端的 `ALLOWED_ORIGINS` 設定中加入你的 GitHub Pages 網址。

## 4. 建議改成正式資料庫

Render 免費方案的檔案系統會在重新部署時重置，如果你要保留資料，建議在 Render 再建立一個 PostgreSQL，然後把 `DATABASE_URL` 填到後端服務環境變數。
