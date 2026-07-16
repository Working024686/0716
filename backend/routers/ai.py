# ====================================================================
# routers/ai.py — AI 分析（機台遙測動態調整 + 決策報告）
# ====================================================================
# GEMINI_API_KEY 只存在於 Render 的環境變數裡，全程不會回傳給前端。
# 機台遙測原始資料現在存在資料庫，不再是前端寫死的 JS 常數。
# ====================================================================
import json
import os
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

import models
from database import get_db
from security import get_current_user
from schemas import TelemetryAnalysisResponse, DynamicsPayload, ReportRequest, ReportResponse

router = APIRouter(prefix="/api/ai", tags=["ai"])

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or None
GEMINI_MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
GEMINI_URL_TMPL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

BASE_DYNAMICS = {
    "setup_hrs": {"turn": 2.0, "hob": 3.0, "grind": 4.0},
    "coefficients": {
        "turn_base": 0.8, "turn_safety": 1.05,
        "hob_base": 1.2,
        "grind_base": 2.5, "grind_safety": 1.1,
    },
}

TELEMETRY_SYSTEM_PROMPT = """你是一位精通精密機械加工（齒輪製造）與排程演算法的 AI 現場工程專家。
請讀取來自資料庫的「現場即時狀態數據（JSON）」，動態調整齒輪加工排程系統的核心實體參數。你必須依據現場的物理限制與機台劣化狀態，給出合理的換線時間（Setup Hours）與切削時間係數的修正值。
1. 車床工序 (Turn)：
   - 若材料硬度 (hardness_HB) 高於 220，將 turn_base（基準 0.8）上調 10%~20%。
   - 若車床刀具磨損度 (tool_wear_pct) 高於 70%，將 turn_safety（基準 1.05）上調 5%~15%。
2. 滾齒工序 (Hob)：
   - 若前一單與目前單的模數 (M) 相同，將 hob 換線時間（基準 3.0 小時）調降 30%~50%。
   - 若機台有溫度偏高警報，換線時間應上調 10%~20%。
3. 磨齒工序 (Grind)：
   - 若有熱膨脹警報，將 grind_base（基準 2.5）與 grind_safety（基準 1.1）同步上調 15%~30%。

你必須「僅」輸出符合以下 schema 的 JSON 格式數據，不要包含任何 Markdown 標記（如 ```json ），也不要寫任何前言或結語：
{
  "setup_hrs": { "turn": 2.0, "hob": 3.0, "grind": 4.0 },
  "coefficients": {
    "turn_base": 0.8, "turn_safety": 1.05,
    "hob_base": 1.2, "grind_base": 2.5, "grind_safety": 1.1
  },
  "explanation": "請在此用 50 字內繁體中文簡述調整原因"
}"""

REPORT_SYSTEM_PROMPT = """你是一位專業的製造業生管經理（Planner）與工廠運營決策顧問。你能夠精準看穿甘特圖背後的產能瓶頸，並以最商業、最專業的口吻提供排程決策。
請根據傳入的 JSON 撰寫一份「插單模擬決策評估報告」。
- 語言：繁體中文
- 格式：Markdown
報告結構：
## 🎯 1. 核心決策建議
（直接說明建議接單、不建議、或條件接單，並敘明理由）
## 💸 2. 財務與時間損益分析
（使用 Markdown 表格呈現各項指標）
## ⚠️ 3. 衝突工單與產能瓶頸診斷
（列出延遲的工單清單與產能偏移量）
## 🛠 4. 生管調度應變方案
（給予交期協商或調度建議）
## ⚙️ 5. AI 機台遙測參數調整說明
（根據傳入 JSON 中的 telemetry_adjustment 欄位，說明本次插單評估時機台因為什麼物理劣化原因（如刀具磨損、溫度偏高、熱膨脹警報等）調整了係數；若 status 為 unavailable，則說明本次沿用出廠基準係數評估。並使用 Markdown 表格呈現「基準值」與「調整後數值」的對比，需包含車床/滾齒/磨齒的換線時間與切削係數。嚴禁輸出 Raw JSON。）"""


async def _call_gemini(system_instruction: str, user_content: str, expect_json: bool) -> str:
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="伺服器尚未設定 GEMINI_API_KEY 環境變數，請至 Render 後台的 Environment 設定。")

    payload = {
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"parts": [{"text": user_content}]}],
        "generationConfig": {"temperature": 0.2},
    }
    if expect_json:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    url = GEMINI_URL_TMPL.format(model=GEMINI_MODEL, key=GEMINI_API_KEY)

    try:
        async with httpx.AsyncClient(timeout=55.0) as client:
            resp = await client.post(url, json=payload)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gemini API 回應逾時，請稍後再試")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"無法連線至 Gemini API：{exc}")

    data = resp.json()
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data.get("error", {}).get("message", "Gemini API 呼叫失敗"))

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail="Gemini 回應格式異常，請稍後再試")

    return text


@router.post("/telemetry-analysis", response_model=TelemetryAnalysisResponse)
async def telemetry_analysis(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    telemetry_row = (
        db.query(models.MachineTelemetry).order_by(models.MachineTelemetry.id.desc()).first()
    )
    telemetry_data = json.loads(telemetry_row.data_json) if telemetry_row else {}

    raw_text = await _call_gemini(
        TELEMETRY_SYSTEM_PROMPT, json.dumps(telemetry_data, ensure_ascii=False, indent=2), expect_json=True
    )
    clean_text = raw_text.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(clean_text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI 回應無法解析為 JSON")

    after = {"setup_hrs": parsed["setup_hrs"], "coefficients": parsed["coefficients"]}

    db.add(models.DynamicsState(
        setup_hrs_json=json.dumps(after["setup_hrs"], ensure_ascii=False),
        coefficients_json=json.dumps(after["coefficients"], ensure_ascii=False),
        explanation=parsed.get("explanation", ""),
    ))
    db.commit()

    return TelemetryAnalysisResponse(
        explanation=parsed.get("explanation", ""),
        before=DynamicsPayload(**BASE_DYNAMICS),
        after=DynamicsPayload(**after),
        timestamp=datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
    )


@router.post("/report", response_model=ReportResponse)
async def generate_report(
    payload: ReportRequest,
    current_user: models.User = Depends(get_current_user),
):
    text = await _call_gemini(
        REPORT_SYSTEM_PROMPT, json.dumps(payload.eval_json, ensure_ascii=False, indent=2), expect_json=False
    )
    return ReportResponse(text=text)
