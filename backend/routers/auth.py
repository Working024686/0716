# ====================================================================
# routers/auth.py — 登入 / 登出
# ====================================================================
# 帳號密碼驗證完全在後端進行，前端從頭到尾看不到密碼或密碼雜湊。
# ====================================================================
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

import models
from database import get_db
from security import verify_password, create_access_token, get_current_user
from schemas import LoginRequest, LoginResponse, UserPublic

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _write_log(db: Session, user: str, action: str, details: str = ""):
    time_str = datetime.now().strftime("%Y/%m/%d %H:%M:%S")
    entry = models.LogEntry(time=time_str, user=user, action=action, details=details)
    db.add(entry)
    db.commit()


@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.emp_id == payload.emp_id).first()
    # 統一回傳同樣的錯誤訊息，不透露「帳號不存在」還是「密碼錯誤」，避免帳號列舉攻擊
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="員工編號或密碼錯誤",
        )

    token = create_access_token(emp_id=user.emp_id, role=user.role)
    _write_log(db, user.emp_id, "登入", f"{user.emp_id} 以 {user.role} 身份登入")

    return LoginResponse(
        access_token=token,
        user=UserPublic(id=user.emp_id, name=user.name, role=user.role),
    )


@router.post("/logout")
def logout(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _write_log(db, current_user.emp_id, "登出", f"{current_user.emp_id} 登出系統")
    return {"status": "ok"}


@router.get("/me", response_model=UserPublic)
def me(current_user: models.User = Depends(get_current_user)):
    return UserPublic(id=current_user.emp_id, name=current_user.name, role=current_user.role)
