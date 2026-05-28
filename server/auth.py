"""Invite + device-session auth (same model as Thymeline)."""

from __future__ import annotations
import secrets
from typing import Optional

from fastapi import Request, HTTPException, status

from .db import DB
from .vault import now_iso

COOKIE = "invpart_token"


def random_token(n: int = 18) -> str:
    return secrets.token_urlsafe(n)


PALETTE = [
    "#f4f4f4", "#cfcfcf", "#a8a8a8",
    "#dfb27a", "#7aa8df", "#9adf7a",
    "#df7a9a", "#7adfcf", "#d4a8df",
]


def pick_color(db: DB) -> str:
    used = {m["color"] for m in db.list_members()}
    for c in PALETTE:
        if c not in used:
            return c
    return PALETTE[db.member_count() % len(PALETTE)]


def current_member(req: Request, db: DB) -> Optional[dict]:
    tok = req.cookies.get(COOKIE)
    if not tok:
        return None
    return db.touch_session(tok, now_iso())


def require_member(req: Request, db: DB) -> dict:
    m = current_member(req, db)
    if not m:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not signed in")
    return m


def require_owner(req: Request, db: DB) -> dict:
    m = require_member(req, db)
    if not m.get("is_owner"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owner only")
    return m


def create_member_and_session(
    db: DB, name: str, device: str, is_owner: bool = False
) -> tuple[dict, str]:
    member_id = random_token(12)
    color = pick_color(db)
    now = now_iso()
    db.create_member({
        "id": member_id, "name": name, "color": color, "device": device,
        "is_owner": is_owner, "joined_at": now,
    })
    token = random_token(24)
    db.create_session(token, member_id, device, now)
    return db.get_member(member_id), token
