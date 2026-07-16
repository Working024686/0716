# ====================================================================
# models.py — 資料庫資料表定義
# ====================================================================
# 重要安全原則：
#   - User.password_hash 永遠不會被序列化回傳給前端（見 schemas.py 的 UserPublic）
#   - 任何「後端內部資料」（密碼雜湊、原始遙測明細、AI 系統提示字串等）
#     一律只留在後端 / 資料庫，前端 UI 只拿得到經過整理、明確允許顯示的欄位。
# ====================================================================
from sqlalchemy import Column, Integer, Float, String, Text, DateTime
from sqlalchemy.sql import func
from database import Base


class User(Base):
    __tablename__ = "users"

    emp_id = Column(String, primary_key=True, index=True)   # e.g. EMP-808
    name = Column(String, nullable=False)
    role = Column(String, nullable=False)                    # Manager / Planner / Operator
    password_hash = Column(String, nullable=False)           # 絕不外流；只在登入驗證時使用


class Order(Base):
    __tablename__ = "orders"

    id = Column(String, primary_key=True, index=True)         # e.g. ORD-101
    type = Column(String, nullable=False)
    M = Column(Float, nullable=False)
    Z = Column(Float, nullable=False)
    b = Column(Float, nullable=False)
    qty = Column(Integer, nullable=False)
    revenue = Column(Float, nullable=False)
    penalty_rate = Column(Float, nullable=False)
    deadline = Column(Float, nullable=False)                  # simulation hour
    sequence_order = Column(Integer, nullable=False, default=0)  # 排程序列位置（插單演算法決定的順序）
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LogEntry(Base):
    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    time = Column(String, nullable=False)
    user = Column(String, nullable=False)
    action = Column(String, nullable=False)
    details = Column(Text, nullable=True)
    before = Column(Text, nullable=True)
    after = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class MachineTelemetry(Base):
    """機台即時遙測快照 — 存在資料庫裡，不再是前端寫死的常數。"""
    __tablename__ = "machine_telemetry"

    id = Column(Integer, primary_key=True, autoincrement=True)
    data_json = Column(Text, nullable=False)   # JSON 字串
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class DynamicsState(Base):
    """每次 AI 動態調整後的最新產線係數（供稽核與追蹤使用）。"""
    __tablename__ = "dynamics_state"

    id = Column(Integer, primary_key=True, autoincrement=True)
    setup_hrs_json = Column(Text, nullable=False)
    coefficients_json = Column(Text, nullable=False)
    explanation = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
