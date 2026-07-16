# ====================================================================
# routers/logs.py — 操作紀錄（唯讀，僅供已登入使用者查詢）
# ====================================================================
from typing import List

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import models
from database import get_db
from security import get_current_user
from schemas import LogOut

router = APIRouter(prefix="/api/logs", tags=["logs"])


@router.get("", response_model=List[LogOut])
def list_logs(
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    logs = (
        db.query(models.LogEntry)
        .order_by(models.LogEntry.id.desc())
        .limit(min(limit, 200))
        .all()
    )
    return [LogOut.model_validate(l) for l in logs]
