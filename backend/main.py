# ====================================================================
# main.py — 齒輪智慧排程系統 後端 (FastAPI)
# ====================================================================
# 前端放 GitHub Pages，後端放 Render。
# 職責：
#   1. 提供正式資料庫（SQLite / 可換 Postgres）儲存使用者、工單、操作紀錄、機台遙測
#   2. 身分驗證（JWT），密碼一律雜湊儲存，前端拿不到任何密碼或雜湊
#   3. 代理呼叫 Gemini AI（API Key 只存在後端環境變數）
# 任何「後端內部資料」（密碼雜湊、API Key、系統提示字串、原始例外堆疊）
# 都不會出現在回傳給前端 UI 的 JSON 裡。
# ====================================================================
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import Base, engine, SessionLocal
from seed import seed_if_empty
from routers import auth, orders, logs, ai

Base.metadata.create_all(bind=engine)

with SessionLocal() as db:
    seed_if_empty(db)

app = FastAPI(title="齒輪智慧排程系統 API", version="2.0.0")

# ---- CORS ----
# ALLOWED_ORIGINS 用逗號分隔多個網址，例如：
# "https://your-username.github.io"
# 正式環境請務必設定明確網址，不要用 "*"
raw_origins = os.environ.get("ALLOWED_ORIGINS", "*").strip()
if raw_origins in ("", "*"):
    allow_origins = ["*"]
else:
    allow_origins = [o.strip() for o in raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(orders.router)
app.include_router(logs.router)
app.include_router(ai.router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"message": "✅ 齒輪智慧排程系統 - FastAPI 後端運作中"}
