# ====================================================================
# seed.py — 首次啟動時的初始資料
# ====================================================================
# 只有在資料表是空的時候才會寫入，不會覆蓋正式環境已存在的資料。
# 預設帳密僅供第一次登入使用，正式上線後請務必請主管盡快在資料庫
# 或未來的「使用者管理」介面中更換密碼。
# ====================================================================
import json
from sqlalchemy.orm import Session

import models
from security import hash_password

DEFAULT_USERS = [
    {"emp_id": "EMP-808", "password": "808", "role": "Manager", "name": "主管"},
    {"emp_id": "EMP-101", "password": "101", "role": "Planner", "name": "生管"},
    {"emp_id": "EMP-202", "password": "202", "role": "Operator", "name": "領班"},
]

DEFAULT_ORDERS = [
    {"id": "ORD-101", "type": "M2", "M": 2, "Z": 50, "b": 40, "qty": 10,
     "revenue": 30000, "penalty_rate": 0.015, "deadline": 164},
    {"id": "ORD-102", "type": "M1", "M": 1, "Z": 30, "b": 20, "qty": 20,
     "revenue": 10000, "penalty_rate": 0.01, "deadline": 116},
    {"id": "ORD-103", "type": "M3", "M": 3, "Z": 80, "b": 60, "qty": 5,
     "revenue": 80000, "penalty_rate": 0.02, "deadline": 308},
]

DEFAULT_TELEMETRY = {
    "current_epoch": "2026-07-15T09:50:00Z",
    "live_telemetry": {
        "lathe1": {"tool_wear_pct": 78, "vibration": "normal"},
        "hob1": {"current_m_setup": 2, "temp_deg": 46},
        "grind1": {"error_code": "W-302_ThermalExpansionWarning", "oil_viscosity": "normal"},
    },
    "material_batch": {
        "type": "SCM440_AlloySteel",
        "hardness_HB": 245,
        "notes": "此批次合金鋼硬度偏高，刀具消耗可能加速",
    },
}


def seed_if_empty(db: Session):
    if db.query(models.User).count() == 0:
        for u in DEFAULT_USERS:
            db.add(models.User(
                emp_id=u["emp_id"],
                name=u["name"],
                role=u["role"],
                password_hash=hash_password(u["password"]),
            ))

    if db.query(models.Order).count() == 0:
        for idx, o in enumerate(DEFAULT_ORDERS):
            db.add(models.Order(sequence_order=idx, **o))

    if db.query(models.MachineTelemetry).count() == 0:
        db.add(models.MachineTelemetry(data_json=json.dumps(DEFAULT_TELEMETRY, ensure_ascii=False)))

    db.commit()
