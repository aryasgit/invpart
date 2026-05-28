"""INVPART — localhost inventory manager.

Same architecture as Thymeline: FastAPI + SQLite-indexed markdown vault,
invite-link sessions, multi-user on LAN.

Run:    uvicorn server.main:app --host 0.0.0.0 --port 8766 --reload
"""

from __future__ import annotations
import os
import json
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import (
    FastAPI, Request, UploadFile, File, Form, HTTPException, status,
)
from fastapi.responses import (
    HTMLResponse, JSONResponse, FileResponse, PlainTextResponse,
)

from .db import DB
from .vault import Vault, now_iso, slugify
from .auth import (
    COOKIE, random_token, current_member, require_member, require_owner,
    create_member_and_session,
)


ROOT = Path(__file__).resolve().parent.parent
VAULT_DIR = Path(os.environ.get("INVPART_VAULT", ROOT / "vault"))
WEB_DIR = ROOT / "web"
DB_PATH = VAULT_DIR / ".invpart.db"
CONFIG_PATH = VAULT_DIR / "project.json"

EVENT_TYPES = {"order", "arrival", "use", "adjust", "note"}
ORDER_STATUSES = {"planned", "placed", "in_transit", "received", "cancelled"}
PART_STATUSES = {"to_order", "ordered", "in_transit"}  # plus null = no status

app = FastAPI(title="INVPART", docs_url=None, redoc_url=None)


DEFAULT_BUDGET_CENTS = 200_00 * 1000  # $200,000.00


def get_config() -> dict:
    cfg = {"name": "Untitled inventory", "created": None,
           "budget_cents": DEFAULT_BUDGET_CENTS}
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    cfg.setdefault("budget_cents", DEFAULT_BUDGET_CENTS)
    return cfg


def write_config(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


db = DB(DB_PATH)
vault = Vault(VAULT_DIR)


# ---------- helpers ----------

NO_STORE = {"Cache-Control": "no-store"}


def device_of(req: Request) -> str:
    return (req.headers.get("user-agent") or "unknown")[:120]


def member_public(m: dict) -> dict:
    return {
        "id": m["id"], "name": m["name"], "color": m["color"],
        "is_owner": bool(m.get("is_owner")),
    }


def members_map() -> dict[str, dict]:
    return {m["id"]: m for m in db.list_members()}


def expand_assets(paths: list[str]) -> list[dict]:
    out = []
    for ap in paths or []:
        full = vault.root / ap
        try:
            size = full.stat().st_size
        except OSError:
            size = None
        out.append({
            "path": ap, "name": ap.rsplit("/", 1)[-1], "size": size,
        })
    return out


def enrich_part(p: dict) -> dict:
    out = dict(p)
    out["assets"] = expand_assets(p.get("assets") or [])
    return out


def enrich_event(e: dict, mm: dict[str, dict]) -> dict:
    out = dict(e)
    a = mm.get(e["author_id"])
    out["author"] = {
        "id": e["author_id"],
        "name": a["name"] if a else "unknown",
        "color": a["color"] if a else "#8a8a8a",
    }
    out["assets"] = expand_assets(e.get("assets") or [])
    return out


def parse_lines_json(raw: str) -> list[dict]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(400, "lines must be JSON")
    if not isinstance(v, list):
        raise HTTPException(400, "lines must be a list")
    out: list[dict] = []
    for ln in v:
        pid = ln.get("part_id")
        if not pid:
            continue
        out.append({
            "part_id": str(pid),
            "qty": float(ln.get("qty") or 0),
            "unit_cost_cents": (int(ln["unit_cost_cents"])
                                 if ln.get("unit_cost_cents") is not None else None),
        })
    return out


# ---------- pages ----------

@app.get("/", response_class=HTMLResponse)
def index_page():
    return HTMLResponse(
        (WEB_DIR / "index.html").read_text(encoding="utf-8"), headers=NO_STORE,
    )


@app.get("/join", response_class=HTMLResponse)
def join_page():
    return HTMLResponse(
        (WEB_DIR / "join.html").read_text(encoding="utf-8"), headers=NO_STORE,
    )


@app.get("/static/{path:path}")
def static_file(path: str):
    target = (WEB_DIR / path).resolve()
    try:
        target.relative_to(WEB_DIR.resolve())
    except ValueError:
        raise HTTPException(404, "not found")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(target, headers=NO_STORE)


# ---------- bootstrap / auth ----------

@app.get("/api/bootstrap")
def bootstrap_status():
    return {"project": get_config(), "owner_set": db.member_count() > 0}


@app.post("/api/bootstrap")
async def bootstrap_owner(req: Request):
    if db.member_count() > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "owner already set")
    body = await req.json()
    name = (body.get("name") or "").strip()
    project = (body.get("project") or "").strip() or "Robot Inventory"
    if not name:
        raise HTTPException(400, "name required")
    write_config({"name": project, "created": now_iso()})
    member, token = create_member_and_session(db, name, device_of(req), is_owner=True)
    resp = JSONResponse({"member": member_public(member), "project": get_config()})
    resp.set_cookie(
        COOKIE, token, max_age=60 * 60 * 24 * 365, httponly=True,
        samesite="lax", path="/",
    )
    return resp


@app.get("/api/me")
def me(req: Request):
    m = current_member(req, db)
    if not m:
        return {"member": None, "project": get_config(), "owner_set": db.member_count() > 0}
    full = db.get_member(m["id"])
    return {"member": member_public(full), "project": get_config(), "owner_set": True}


@app.post("/api/invite")
def create_invite(req: Request):
    owner = require_owner(req, db)
    token = random_token(16)
    db.create_invite(token, owner["id"], now_iso())
    host = req.headers.get("host", "localhost")
    scheme = req.headers.get("x-forwarded-proto", req.url.scheme or "http")
    return {"token": token, "url": f"{scheme}://{host}/join?t={token}"}


@app.get("/api/invite/{token}")
def invite_info(token: str):
    with db.conn() as c:
        r = c.execute(
            "SELECT i.token,i.used_at,m.name AS created_by_name "
            "FROM invites i JOIN members m ON m.id = i.created_by "
            "WHERE i.token=?", (token,),
        ).fetchone()
    if not r:
        raise HTTPException(404, "invite not found")
    return {
        "token": r["token"], "used": bool(r["used_at"]),
        "invited_by": r["created_by_name"], "project": get_config(),
    }


@app.post("/api/join")
async def join_with_invite(req: Request):
    body = await req.json()
    token = (body.get("token") or "").strip()
    name = (body.get("name") or "").strip()
    if not token or not name:
        raise HTTPException(400, "token and name required")
    member, session_token = create_member_and_session(
        db, name, device_of(req), is_owner=False
    )
    if not db.consume_invite(token, member["id"], now_iso()):
        with db.conn() as c:
            c.execute("DELETE FROM sessions WHERE member_id=?", (member["id"],))
            c.execute("DELETE FROM members WHERE id=?", (member["id"],))
        raise HTTPException(400, "invite invalid or already used")
    resp = JSONResponse({"member": member_public(member), "project": get_config()})
    resp.set_cookie(
        COOKIE, session_token, max_age=60 * 60 * 24 * 365, httponly=True,
        samesite="lax", path="/",
    )
    return resp


@app.get("/api/members")
def list_members(req: Request):
    require_member(req, db)
    return {"members": db.list_members()}


# ---------- parts ----------

@app.get("/api/parts")
def list_parts(
    req: Request,
    q: Optional[str] = None,
    category: Optional[str] = None,
    tag: Optional[str] = None,
    status: Optional[str] = None,
    low_stock: bool = False,
    sort: str = "name",
):
    require_member(req, db)
    rows = db.list_parts(q=q, category=category, tag=tag, status=status,
                         low_stock=low_stock, sort=sort)
    return {"parts": [enrich_part(p) for p in rows]}


@app.get("/api/parts/{part_id}")
def get_part(part_id: str, req: Request):
    require_member(req, db)
    p = db.get_part(part_id)
    if not p:
        raise HTTPException(404, "not found")
    return enrich_part(p)


@app.post("/api/parts")
async def create_part(
    req: Request,
    name: str = Form(...),
    category: str = Form(""),
    supplier: str = Form(""),
    link: str = Form(""),
    unit: str = Form("each"),
    unit_cost_cents: Optional[int] = Form(None),
    on_hand: float = Form(0),
    target_min: float = Form(0),
    status: str = Form(""),
    notes: str = Form(""),
    tags: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    me_ = require_member(req, db)
    name = (name or "").strip()
    if not name:
        raise HTTPException(400, "name required")
    iso = now_iso()
    pid = random_token(10)

    asset_paths: list[str] = []
    image: Optional[str] = None
    now = datetime.now(timezone.utc)
    for f in files or []:
        if not f.filename:
            continue
        rel = await vault.save_asset_stream(f, f.filename, now)
        full = vault.root / rel
        if not full.stat().st_size:
            full.unlink(missing_ok=True); continue
        # First image becomes the part image
        if image is None and f.content_type and f.content_type.startswith("image/"):
            image = rel
        asset_paths.append(rel)

    tag_list = sorted({t.strip().lstrip("#").lower()
                       for t in tags.split(",") if t.strip()})

    st = (status or "").strip().lower() or None
    if st and st not in PART_STATUSES:
        st = None
    payload = {
        "id": pid, "name": name,
        "category": (category or "").strip() or None,
        "supplier": (supplier or "").strip() or None,
        "link": (link or "").strip() or None,
        "unit": unit or "each",
        "unit_cost_cents": unit_cost_cents,
        "on_hand": max(0.0, on_hand or 0),
        "on_order": 0,
        "target_min": max(0.0, target_min or 0),
        "status": st,
        "notes": notes or "",
        "image": image,
        "tags": tag_list,
        "assets": asset_paths,
        "created_at": iso, "updated_at": iso,
        "created_by": me_["id"],
    }
    path = vault.write_part(payload)
    payload["file_path"] = path.relative_to(vault.root).as_posix()
    db.upsert_part(payload)
    return enrich_part(db.get_part(pid))


@app.patch("/api/parts/{part_id}")
async def update_part(part_id: str, req: Request):
    me_ = require_member(req, db)
    existing = db.get_part(part_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing.get("created_by") and existing["created_by"] != me_["id"] and not me_.get("is_owner"):
        # Not strict — anyone in team can edit any part, but owner has final say.
        # Loosened: allow all members to edit parts (it's a team inventory).
        pass
    body = await req.json()
    iso = now_iso()
    fields = ["name", "category", "supplier", "link", "unit", "notes"]
    new = dict(existing)
    for f in fields:
        if f in body:
            new[f] = (body[f] or "").strip() if body[f] is not None else None
            if f == "name" and not new[f]:
                new[f] = existing[f]
            if f == "unit" and not new[f]:
                new[f] = "each"
    for f in ("unit_cost_cents", "on_hand", "on_order", "target_min"):
        if f in body and body[f] is not None:
            new[f] = float(body[f]) if f != "unit_cost_cents" else int(body[f])
    if "status" in body:
        s = (body["status"] or "").strip().lower() if body["status"] else None
        new["status"] = s if s in PART_STATUSES else None
    if "tags" in body:
        new["tags"] = sorted({str(t).lstrip("#").lower()
                              for t in (body["tags"] or [])})
    if "image" in body:
        new["image"] = body["image"] or None
    new["updated_at"] = iso
    path = vault.write_part(new)
    new["file_path"] = path.relative_to(vault.root).as_posix()
    db.upsert_part(new)
    return enrich_part(db.get_part(part_id))


@app.post("/api/parts/{part_id}/assets")
async def add_part_assets(
    part_id: str,
    req: Request,
    files: list[UploadFile] = File(default=[]),
):
    require_member(req, db)
    existing = db.get_part(part_id)
    if not existing:
        raise HTTPException(404, "not found")
    now = datetime.now(timezone.utc)
    assets = list(existing.get("assets") or [])
    for f in files or []:
        if not f.filename:
            continue
        rel = await vault.save_asset_stream(f, f.filename, now)
        full = vault.root / rel
        if not full.stat().st_size:
            full.unlink(missing_ok=True); continue
        assets.append(rel)
        if not existing.get("image") and f.content_type and f.content_type.startswith("image/"):
            existing["image"] = rel
    existing["assets"] = assets
    existing["updated_at"] = now_iso()
    path = vault.write_part(existing)
    existing["file_path"] = path.relative_to(vault.root).as_posix()
    db.upsert_part(existing)
    return enrich_part(db.get_part(part_id))


@app.delete("/api/parts/{part_id}")
def delete_part(part_id: str, req: Request):
    me_ = require_member(req, db)
    existing = db.get_part(part_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing.get("created_by") and existing["created_by"] != me_["id"] and not me_.get("is_owner"):
        raise HTTPException(403, "owner can delete others' parts")
    vault.delete_part(existing["file_path"])
    db.delete_part(part_id)
    return {"ok": True}


# ---------- events ----------

@app.post("/api/events")
async def create_event(
    req: Request,
    type: str = Form(...),
    lines: str = Form("[]"),                 # JSON: [{part_id, qty, unit_cost_cents}]
    status: str = Form(""),
    supplier: str = Form(""),
    tracking_url: str = Form(""),
    expected_arrival: str = Form(""),
    cost_cents: Optional[int] = Form(None),
    body: str = Form(""),
    files: list[UploadFile] = File(default=[]),
):
    me_ = require_member(req, db)
    if type not in EVENT_TYPES:
        raise HTTPException(400, f"unknown type {type!r}")
    if type == "order":
        s = status or "placed"
        if s not in ORDER_STATUSES:
            raise HTTPException(400, f"unknown order status {s!r}")
        status = s
    else:
        status = status or None
    line_items = parse_lines_json(lines)

    # Save assets
    now = datetime.now(timezone.utc)
    iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    asset_paths: list[str] = []
    for f in files or []:
        if not f.filename:
            continue
        rel = await vault.save_asset_stream(f, f.filename, now)
        full = vault.root / rel
        if not full.stat().st_size:
            full.unlink(missing_ok=True); continue
        asset_paths.append(rel)

    # Compute cost_cents from lines if not given
    if cost_cents is None and line_items:
        total = 0
        any_ = False
        for ln in line_items:
            if ln.get("unit_cost_cents") is not None and ln["qty"]:
                total += int(round(ln["unit_cost_cents"] * abs(ln["qty"])))
                any_ = True
        if any_:
            cost_cents = total

    eid = random_token(10)
    member = db.get_member(me_["id"])
    payload = {
        "id": eid, "type": type, "status": status,
        "supplier": (supplier or "").strip() or None,
        "tracking_url": (tracking_url or "").strip() or None,
        "expected_arrival": (expected_arrival or "").strip() or None,
        "cost_cents": cost_cents,
        "body": (body or "").strip(),
        "author_id": me_["id"],
        "author_name": member["name"] if member else me_.get("name", ""),
        "lines": line_items,
        "assets": asset_paths,
        "created_at": iso, "updated_at": iso,
    }
    path = vault.write_event(payload)
    payload["file_path"] = path.relative_to(vault.root).as_posix()
    db.create_event(payload, line_items)

    # Apply qty side-effects
    _apply_event_qty(type, status, line_items, iso, reverse=False)

    return enrich_event(db.get_event(eid), members_map())


def _apply_event_qty(type_: str, status: Optional[str], lines: list[dict],
                     iso: str, reverse: bool = False):
    """Update part on_hand and on_order based on an event.
    `reverse=True` undoes the effect (used when editing/deleting).
    Re-writes the part's markdown file so disk stays in sync with DB."""
    sign = -1 if reverse else 1
    touched: set[str] = set()
    for ln in lines:
        pid = ln["part_id"]
        qty = float(ln["qty"]) * sign
        if type_ == "order":
            if status == "received":
                db.adjust_part_qty(pid, on_hand_delta=qty, now=iso)
            elif status == "cancelled":
                pass
            else:
                # placed / in_transit / planned — counts toward on_order
                db.adjust_part_qty(pid, on_order_delta=qty, now=iso)
        elif type_ == "arrival":
            db.adjust_part_qty(pid, on_hand_delta=qty, on_order_delta=-qty, now=iso)
        elif type_ == "use":
            db.adjust_part_qty(pid, on_hand_delta=-qty, now=iso)
        elif type_ == "adjust":
            db.adjust_part_qty(
                pid, on_hand_delta=float(ln["qty"]) * (1 if not reverse else -1),
                now=iso,
            )
        # note: no qty effect
        touched.add(pid)
    # Sync touched parts' markdown files
    for pid in touched:
        p = db.get_part(pid)
        if p:
            vault.write_part(p)


@app.patch("/api/events/{event_id}")
async def update_event(event_id: str, req: Request):
    me_ = require_member(req, db)
    existing = db.get_event(event_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing["author_id"] != me_["id"] and not me_.get("is_owner"):
        raise HTTPException(403, "not your event")
    body = await req.json()

    # Reverse old qty effect
    _apply_event_qty(
        existing["type"], existing.get("status"), existing.get("lines", []),
        now_iso(), reverse=True,
    )

    new_type = body.get("type", existing["type"])
    if new_type not in EVENT_TYPES:
        new_type = existing["type"]
    new_status = body.get("status", existing.get("status"))
    if new_type == "order":
        if new_status not in ORDER_STATUSES:
            new_status = "placed"

    new_lines = existing.get("lines", [])
    if "lines" in body:
        new_lines = []
        for ln in body["lines"]:
            new_lines.append({
                "part_id": str(ln["part_id"]),
                "qty": float(ln.get("qty") or 0),
                "unit_cost_cents": ln.get("unit_cost_cents"),
            })

    iso = now_iso()
    member = db.get_member(existing["author_id"])
    payload = {
        **existing,
        "type": new_type, "status": new_status,
        "supplier": body.get("supplier", existing.get("supplier")),
        "tracking_url": body.get("tracking_url", existing.get("tracking_url")),
        "expected_arrival": body.get("expected_arrival", existing.get("expected_arrival")),
        "cost_cents": body.get("cost_cents", existing.get("cost_cents")),
        "body": body.get("body", existing.get("body", "")),
        "lines": new_lines,
        "author_name": member["name"] if member else "",
        "updated_at": iso,
    }
    path = vault.write_event(payload)
    payload["file_path"] = path.relative_to(vault.root).as_posix()
    db.update_event(payload, new_lines)

    # Apply new qty effect
    _apply_event_qty(new_type, new_status, new_lines, iso, reverse=False)
    return enrich_event(db.get_event(event_id), members_map())


@app.post("/api/events/{event_id}/receive")
def receive_event(event_id: str, req: Request):
    """Mark a placed/in_transit order as received — moves on_order → on_hand."""
    me_ = require_member(req, db)
    existing = db.get_event(event_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing["type"] != "order":
        raise HTTPException(400, "only orders can be received")
    if existing.get("status") == "received":
        return enrich_event(existing, members_map())

    iso = now_iso()
    # Reverse the previous "placed" effect (on_order +)
    _apply_event_qty(
        "order", existing.get("status"), existing.get("lines", []),
        iso, reverse=True,
    )
    existing["status"] = "received"
    existing["updated_at"] = iso
    member = db.get_member(existing["author_id"])
    existing["author_name"] = member["name"] if member else ""
    path = vault.write_event(existing)
    existing["file_path"] = path.relative_to(vault.root).as_posix()
    db.update_event(existing, existing.get("lines", []))
    # Apply the "received" effect (on_hand +)
    _apply_event_qty("order", "received", existing.get("lines", []), iso)
    return enrich_event(db.get_event(event_id), members_map())


@app.delete("/api/events/{event_id}")
def delete_event(event_id: str, req: Request):
    me_ = require_member(req, db)
    existing = db.get_event(event_id)
    if not existing:
        raise HTTPException(404, "not found")
    if existing["author_id"] != me_["id"] and not me_.get("is_owner"):
        raise HTTPException(403, "not your event")
    # Reverse qty effect
    _apply_event_qty(
        existing["type"], existing.get("status"), existing.get("lines", []),
        now_iso(), reverse=True,
    )
    vault.delete_event(existing["file_path"])
    db.delete_event(event_id)
    return {"ok": True}


@app.get("/api/events")
def list_events(
    req: Request,
    limit: int = 200,
    before: Optional[str] = None,
    type: Optional[str] = None,
    status: Optional[str] = None,
    part_id: Optional[str] = None,
    author: Optional[str] = None,
):
    require_member(req, db)
    if type and type not in EVENT_TYPES:
        type = None
    rows = db.list_events(
        limit=min(max(limit, 1), 500), before=before, type_=type,
        status=status, part_id=part_id, author=author,
    )
    mm = members_map()
    return {"events": [enrich_event(e, mm) for e in rows]}


# ---------- stats ----------

def _committed_cents(p: dict) -> int:
    """Money already 'spent' on this part: it's either in stock, in transit,
    or with an order placed. Falls back to qty=1 when neither on_hand nor
    target_min give us a number."""
    unit = p.get("unit_cost_cents") or 0
    if not unit:
        return 0
    on_hand = float(p.get("on_hand") or 0)
    target = float(p.get("target_min") or 0)
    status = p.get("status")
    if status in ("in_transit", "ordered"):
        qty = max(on_hand, target if target > 0 else 1.0)
        return int(round(qty * unit))
    if on_hand > 0:
        return int(round(on_hand * unit))
    return 0


def _planned_cents(p: dict) -> int:
    """Money for parts that still need to be ordered (status=to_order)."""
    if p.get("status") != "to_order":
        return 0
    unit = p.get("unit_cost_cents") or 0
    if not unit:
        return 0
    target = float(p.get("target_min") or 0)
    qty = target if target > 0 else 1.0
    return int(round(qty * unit))


@app.get("/api/stats")
def stats(req: Request):
    require_member(req, db)
    cfg = get_config()
    budget = int(cfg.get("budget_cents") or DEFAULT_BUDGET_CENTS)
    parts = db.list_parts()
    total_spent = sum(_committed_cents(p) for p in parts)
    planned = sum(_planned_cents(p) for p in parts)
    remaining = budget - total_spent
    return {
        "parts": db.part_count(),
        "members": db.member_count(),
        # New canonical totals
        "total_spent_cents": total_spent,
        "planned_expenses_cents": planned,
        "remaining_balance_cents": remaining,
        "budget_cents": budget,
        # Legacy / breakdown
        "stock_value_cents": db.total_stock_value_cents(),
        "spent_cents": db.total_spent_cents(),
        "in_transit_cents": db.in_transit_cents(),
        "by_month": db.spend_by_month(),
        "by_category": db.spend_by_category(),
        "categories": db.categories(),
        "host": socket.gethostname(),
    }


@app.get("/api/pending")
def pending(req: Request):
    require_member(req, db)
    orders = db.in_transit_orders()
    mm = members_map()
    # "Reorder list" is now driven by the part-level status flag the user
    # explicitly sets. We surface parts they've flagged as "to_order"
    # alongside any old-style low-stock parts (so existing target_min data
    # still has meaning if it was set on legacy entries).
    to_order = db.list_parts(status="to_order", sort="updated")
    low = db.list_parts(low_stock=True, sort="qty_asc")
    seen = {p["id"] for p in to_order}
    reorder = list(to_order) + [p for p in low if p["id"] not in seen]
    flagged_transit = db.list_parts(status="in_transit", sort="updated")
    flagged_ordered = db.list_parts(status="ordered", sort="updated")
    return {
        "in_transit": [enrich_event(e, mm) for e in orders],
        "reorder": [enrich_part(p) for p in reorder],
        "flagged_in_transit": [enrich_part(p) for p in flagged_transit],
        "flagged_ordered": [enrich_part(p) for p in flagged_ordered],
    }


@app.get("/api/tags")
def list_tags(req: Request):
    require_member(req, db)
    tags = db.all_tags()
    return {
        "tags": tags,
        "tag_names": [t["tag"] for t in tags],
        "categories": db.categories(),
    }


# ---------- assets ----------

@app.get("/asset/{path:path}")
def asset(path: str, req: Request):
    require_member(req, db)
    full = vault.asset_full_path(f"assets/{path}")
    if not full:
        raise HTTPException(404, "not found")
    return FileResponse(full)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"
