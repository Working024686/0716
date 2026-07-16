# ====================================================================
# security.py — 密碼雜湊 + JWT 驗證
# ====================================================================
# 密碼絕不以明文儲存或回傳；一律用 bcrypt 雜湊後存進資料庫。
# 登入成功後發一組 JWT，之後所有需要身分的 API 都必須夾帶
# "Authorization: Bearer <token>"，後端驗證 token 才放行。
# ====================================================================
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from database import get_db
import models

# ---- 設定 ----
# 正式環境務必在 Render 環境變數設定一組隨機字串，不要使用預設值
SECRET_KEY = os.environ.get("JWT_SECRET_KEY") or "dev-only-change-me-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES") or "720")  # 12 小時

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(plain_password: str) -> str:
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return pwd_context.verify(plain_password, password_hash)


def create_access_token(emp_id: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": emp_id, "role": role, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登入狀態已失效，請重新登入",
        )


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """任何需要登入才能呼叫的 API，都用這個 dependency 取得目前使用者。"""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="請先登入",
        )
    payload = decode_access_token(credentials.credentials)
    emp_id = payload.get("sub")
    user = db.query(models.User).filter(models.User.emp_id == emp_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="使用者不存在")
    return user


def require_roles(*roles: str):
    """依角色限制存取，例如 require_roles('Manager', 'Planner')。"""
    def checker(user: models.User = Depends(get_current_user)) -> models.User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"角色 {user.role} 無此操作權限",
            )
        return user
    return checker
