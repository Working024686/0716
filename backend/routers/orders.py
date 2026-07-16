# ====================================================================
# routers/orders.py — 工單資料（正式資料庫存取，取代前端 localStorage）
# ====================================================================
import json
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import models
from database import get_db
from security import get_current_user, require_roles
from schemas import OrderCreate, OrderUpdate, OrderOut, ApplyInsertionRequest

router = APIRouter(prefix="/api/orders", tags=["orders"])


def _order_to_out(o: models.Order) -> OrderOut:
    return OrderOut(
        id=o.id, type=o.type, M=o.M, Z=o.Z, b=o.b, qty=o.qty,
        revenue=o.revenue, penaltyRate=o.penalty_rate, deadline=o.deadline,
    )


def _write_log(db: Session, user: str, action: str, details: str = "", before: str = "", after: str = ""):
    time_str = datetime.now().strftime("%Y/%m/%d %H:%M:%S")
    entry = models.LogEntry(time=time_str, user=user, action=action, details=details, before=before, after=after)
    db.add(entry)
    db.commit()


@router.get("", response_model=List[OrderOut])
def list_orders(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    orders = db.query(models.Order).order_by(models.Order.sequence_order.asc()).all()
    return [_order_to_out(o) for o in orders]


@router.post("", response_model=OrderOut)
def create_order(
    payload: OrderCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("Manager", "Planner")),
):
    if db.query(models.Order).filter(models.Order.id == payload.id).first():
        raise HTTPException(status_code=409, detail=f"工單 {payload.id} 已存在")

    max_seq = db.query(models.Order).count()
    order = models.Order(
        id=payload.id, type=payload.type, M=payload.M, Z=payload.Z, b=payload.b,
        qty=payload.qty, revenue=payload.revenue, penalty_rate=payload.penaltyRate,
        deadline=payload.deadline, sequence_order=max_seq,
    )
    db.add(order)
    _write_log(
        db, current_user.emp_id, "插單寫入", f"插入 {payload.id}",
        after=f"淨利益相關工單已寫入資料庫",
    )
    db.refresh(order)
    return _order_to_out(order)


@router.post("/apply-insertion", response_model=List[OrderOut])
def apply_insertion(
    payload: ApplyInsertionRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("Manager", "Planner")),
):
    """
    插單評估流程用的原子操作：同時寫入新工單，並把「插單演算法」算出的
    最佳排程序列（可能會重新排列既有工單的順序）整個持久化到資料庫，
    確保下次讀取時排程結果與評估當下完全一致。
    """
    new_order = payload.new_order
    if db.query(models.Order).filter(models.Order.id == new_order.id).first():
        raise HTTPException(status_code=409, detail=f"工單 {new_order.id} 已存在")

    if new_order.id not in payload.sequence:
        raise HTTPException(status_code=400, detail="sequence 中缺少新工單 ID")

    order = models.Order(
        id=new_order.id, type=new_order.type, M=new_order.M, Z=new_order.Z, b=new_order.b,
        qty=new_order.qty, revenue=new_order.revenue, penalty_rate=new_order.penaltyRate,
        deadline=new_order.deadline, sequence_order=payload.sequence.index(new_order.id),
    )
    db.add(order)

    # 重新排列既有工單的 sequence_order
    for idx, order_id in enumerate(payload.sequence):
        if order_id == new_order.id:
            continue
        existing = db.query(models.Order).filter(models.Order.id == order_id).first()
        if existing:
            existing.sequence_order = idx

    detail = f"插入 {new_order.id}" + ("（主管特許強制覆核）" if payload.is_override else "")
    after = f"淨利益: NT${round(payload.net_profit):,}" if payload.net_profit is not None else ""
    _write_log(db, current_user.emp_id, "插單寫入", detail, after=after)

    orders = db.query(models.Order).order_by(models.Order.sequence_order.asc()).all()
    return [_order_to_out(o) for o in orders]


@router.put("/{order_id}", response_model=OrderOut)
def update_order(
    order_id: str,
    payload: OrderUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("Manager", "Planner")),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="找不到此工單")

    before_json = json.dumps(_order_to_out(order).model_dump(), ensure_ascii=False)

    order.M = payload.M
    order.Z = payload.Z
    order.b = payload.b
    order.qty = payload.qty
    order.revenue = payload.revenue
    order.penalty_rate = payload.penaltyRate
    order.deadline = payload.deadline

    after_json = json.dumps(_order_to_out(order).model_dump(), ensure_ascii=False)
    _write_log(db, current_user.emp_id, "編輯工單", f"修改 {order_id}", before=before_json, after=after_json)
    db.refresh(order)
    return _order_to_out(order)


@router.delete("/{order_id}")
def delete_order(
    order_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_roles("Manager", "Planner")),
):
    order = db.query(models.Order).filter(models.Order.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="找不到此工單")

    before_json = json.dumps(_order_to_out(order).model_dump(), ensure_ascii=False)
    db.delete(order)
    _write_log(db, current_user.emp_id, "刪除工單", f"刪除 {order_id}", before=before_json)
    return {"status": "ok"}
