# ====================================================================
# schemas.py — Pydantic 資料驗證 / 序列化模型
# ====================================================================
# 這裡的每一個 "Public" / "Out" schema 都刻意只挑選允許讓前端看到的欄位，
# 確保像 password_hash 這類後端內部資料絕對不會混入 API 回應。
# ====================================================================
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List


# ---------- Auth ----------
class LoginRequest(BaseModel):
    emp_id: str
    password: str


class UserPublic(BaseModel):
    id: str
    name: str
    role: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# ---------- Orders ----------
class OrderCreate(BaseModel):
    id: str
    type: str
    M: float
    Z: float
    b: float
    qty: int
    revenue: float
    penaltyRate: float = Field(alias="penaltyRate")
    deadline: float

    model_config = {"populate_by_name": True}


class OrderUpdate(BaseModel):
    M: float
    Z: float
    b: float
    qty: int
    revenue: float
    penaltyRate: float = Field(alias="penaltyRate")
    deadline: float

    model_config = {"populate_by_name": True}


class OrderOut(BaseModel):
    id: str
    type: str
    M: float
    Z: float
    b: float
    qty: int
    revenue: float
    penaltyRate: float
    deadline: float

    model_config = {"from_attributes": True}


class ApplyInsertionRequest(BaseModel):
    new_order: OrderCreate
    sequence: List[str]           # 插單演算法算出的最佳排序（工單 ID 陣列，含新單）
    is_override: bool = False
    net_profit: Optional[float] = None


# ---------- Logs ----------
class LogCreate(BaseModel):
    action: str
    details: Optional[str] = ""
    before: Optional[str] = ""
    after: Optional[str] = ""


class LogOut(BaseModel):
    time: str
    user: str
    action: str
    details: Optional[str] = ""
    before: Optional[str] = ""
    after: Optional[str] = ""

    model_config = {"from_attributes": True}


# ---------- AI / Telemetry ----------
class DynamicsPayload(BaseModel):
    setup_hrs: Dict[str, float]
    coefficients: Dict[str, float]


class TelemetryAnalysisResponse(BaseModel):
    explanation: str
    before: DynamicsPayload
    after: DynamicsPayload
    timestamp: str


class ReportRequest(BaseModel):
    eval_json: Dict[str, Any]


class ReportResponse(BaseModel):
    text: str
