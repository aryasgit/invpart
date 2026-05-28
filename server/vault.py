"""Markdown vault — source of truth for parts and events.

vault/
├── parts/                    # one .md per part
│   └── HX-12-servo.md
├── events/                   # one .md per event (order/use/arrival/adjust/note)
│   └── 2026-05-28T11-23-00Z_order_abc123.md
└── assets/YYYY/MM/DD/        # part photos, datasheets, invoices
"""

from __future__ import annotations
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Iterable

import yaml


FRONT_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)


def slugify(s: str, max_len: int = 60) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s[:max_len] or "part"


class Vault:
    def __init__(self, root: Path):
        self.root = root
        self.parts_dir = root / "parts"
        self.events_dir = root / "events"
        self.assets_dir = root / "assets"
        for d in (self.parts_dir, self.events_dir, self.assets_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ----- parts -----
    def part_path(self, part_id: str, name: str) -> Path:
        slug = slugify(name)
        return self.parts_dir / f"{slug}_{part_id[:6]}.md"

    def write_part(self, p: dict) -> Path:
        fm = {
            "id": p["id"], "name": p["name"],
            "category": p.get("category") or "",
            "supplier": p.get("supplier") or "",
            "link": p.get("link") or "",
            "unit": p.get("unit", "each"),
            "unit_cost_cents": p.get("unit_cost_cents"),
            "on_hand": p.get("on_hand", 0),
            "on_order": p.get("on_order", 0),
            "target_min": p.get("target_min", 0),
            "status": p.get("status") or "",
            "image": p.get("image") or "",
            "tags": p.get("tags") or [],
            "assets": p.get("assets") or [],
            "created": p["created_at"], "updated": p["updated_at"],
            "created_by": p.get("created_by") or "",
        }
        front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).strip()
        body = p.get("notes") or ""
        text = f"---\n{front}\n---\n\n{body}\n"
        path = p.get("file_path")
        path = (self.root / path) if path else self.part_path(p["id"], p["name"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def delete_part(self, file_path: str) -> None:
        p = self.root / file_path
        if p.exists():
            p.unlink()

    def read_part(self, path: Path) -> Optional[dict]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        m = FRONT_RE.match(text)
        if not m:
            return None
        try:
            fm = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            return None
        if not fm.get("id"):
            return None
        rel = path.relative_to(self.root).as_posix()
        return {
            "id": str(fm["id"]),
            "name": fm.get("name") or "",
            "category": fm.get("category") or None,
            "supplier": fm.get("supplier") or None,
            "link": fm.get("link") or None,
            "unit": fm.get("unit") or "each",
            "unit_cost_cents": fm.get("unit_cost_cents"),
            "on_hand": float(fm.get("on_hand") or 0),
            "on_order": float(fm.get("on_order") or 0),
            "target_min": float(fm.get("target_min") or 0),
            "status": fm.get("status") or None,
            "notes": m.group(2).strip(),
            "image": fm.get("image") or None,
            "tags": list(fm.get("tags") or []),
            "assets": list(fm.get("assets") or []),
            "file_path": rel,
            "created_at": fm.get("created") or "",
            "updated_at": fm.get("updated") or fm.get("created") or "",
            "created_by": fm.get("created_by") or None,
        }

    def iter_parts(self) -> Iterable[dict]:
        for p in self.parts_dir.rglob("*.md"):
            r = self.read_part(p)
            if r:
                yield r

    # ----- events -----
    def event_path(self, event_id: str, created_at: str, type_: str) -> Path:
        ts = created_at.replace(":", "-").replace(".", "-")
        return self.events_dir / f"{ts}_{type_}_{event_id[:6]}.md"

    def write_event(self, e: dict) -> Path:
        fm = {
            "id": e["id"], "type": e["type"],
            "status": e.get("status") or "",
            "supplier": e.get("supplier") or "",
            "tracking_url": e.get("tracking_url") or "",
            "expected_arrival": e.get("expected_arrival") or "",
            "cost_cents": e.get("cost_cents"),
            "author": e.get("author_name") or "",
            "author_id": e["author_id"],
            "created": e["created_at"], "updated": e["updated_at"],
            "lines": e.get("lines") or [],
            "assets": e.get("assets") or [],
        }
        front = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).strip()
        body = e.get("body") or ""
        text = f"---\n{front}\n---\n\n{body}\n"
        path = e.get("file_path")
        path = (self.root / path) if path else self.event_path(
            e["id"], e["created_at"], e["type"]
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def delete_event(self, file_path: str) -> None:
        p = self.root / file_path
        if p.exists():
            p.unlink()

    def read_event(self, path: Path) -> Optional[dict]:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        m = FRONT_RE.match(text)
        if not m:
            return None
        try:
            fm = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            return None
        if not fm.get("id"):
            return None
        rel = path.relative_to(self.root).as_posix()
        return {
            "id": str(fm["id"]),
            "type": fm.get("type") or "note",
            "status": fm.get("status") or None,
            "supplier": fm.get("supplier") or None,
            "tracking_url": fm.get("tracking_url") or None,
            "expected_arrival": fm.get("expected_arrival") or None,
            "cost_cents": fm.get("cost_cents"),
            "body": m.group(2).strip(),
            "author_id": fm.get("author_id") or "",
            "author_name": fm.get("author") or "",
            "lines": list(fm.get("lines") or []),
            "assets": list(fm.get("assets") or []),
            "file_path": rel,
            "created_at": fm.get("created") or "",
            "updated_at": fm.get("updated") or fm.get("created") or "",
        }

    def iter_events(self) -> Iterable[dict]:
        for p in self.events_dir.rglob("*.md"):
            r = self.read_event(p)
            if r:
                yield r

    # ----- assets -----
    def _asset_target(self, original_name: str, when: datetime) -> Path:
        sub = when.strftime("%Y/%m/%d")
        target_dir = self.assets_dir / sub
        target_dir.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", original_name).strip("-") or "file"
        ts = when.strftime("%H%M%S")
        target = target_dir / f"{ts}-{safe}"
        n = 1
        while target.exists():
            target = target_dir / f"{ts}-{n}-{safe}"
            n += 1
        return target

    async def save_asset_stream(self, upload_file, original_name: str, when: datetime,
                                 chunk_size: int = 1024 * 1024) -> str:
        target = self._asset_target(original_name, when)
        with target.open("wb") as out:
            while True:
                chunk = await upload_file.read(chunk_size)
                if not chunk:
                    break
                out.write(chunk)
        return target.relative_to(self.root).as_posix()

    def asset_full_path(self, relative: str) -> Optional[Path]:
        try:
            full = (self.root / relative).resolve()
            full.relative_to(self.assets_dir.resolve())
        except (ValueError, OSError):
            return None
        return full if full.exists() else None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
