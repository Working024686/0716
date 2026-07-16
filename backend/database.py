# ====================================================================
# database.py — 正式資料庫連線設定 (SQLAlchemy)
# ====================================================================
# 預設使用本機檔案型 SQLite 資料庫（適合小型部署 / Render 單一 instance）。
# 若要接正式 PostgreSQL（例如 Render Postgres、Supabase 等），
# 只要在環境變數設定 DATABASE_URL（例如 postgresql+psycopg2://user:pwd@host/db），
# 完全不需要改任何程式碼。
# ====================================================================
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.environ.get("DATABASE_URL") or "sqlite:///./gear_scheduler.db"

connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    # SQLite 需要這個參數才能在多執行緒的 FastAPI 環境下運作
    connect_args = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """FastAPI dependency：每個請求開一個 DB session，用完自動關閉。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
