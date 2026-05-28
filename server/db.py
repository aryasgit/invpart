"""SQLite index over the markdown vault.

Source of truth: vault/parts/*.md and vault/events/*.md.
This DB is a queryable mirror that gets rebuilt from files if missing."""

from __future__ import annotations
import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    device TEXT,
    is_owner INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    device TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    token TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES members(id),
    created_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    supplier TEXT,
    link TEXT,
    unit TEXT NOT NULL DEFAULT 'each',
    unit_cost_cents INTEGER,
    on_hand REAL NOT NULL DEFAULT 0,
    on_order REAL NOT NULL DEFAULT 0,
    target_min REAL NOT NULL DEFAULT 0,
    status TEXT,
    notes TEXT NOT NULL DEFAULT '',
    image TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    assets TEXT NOT NULL DEFAULT '[]',
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS idx_parts_name ON parts(name);
CREATE INDEX IF NOT EXISTS idx_parts_category ON parts(category);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                -- order, arrival, use, adjust, note
    status TEXT,                       -- for orders: planned|placed|in_transit|received|cancelled
    supplier TEXT,
    tracking_url TEXT,
    expected_arrival TEXT,
    cost_cents INTEGER,                -- total cost in cents
    body TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL REFERENCES members(id),
    file_path TEXT NOT NULL,
    assets TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS event_parts (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    qty REAL NOT NULL,                 -- positive for in, negative for out
    unit_cost_cents INTEGER,
    PRIMARY KEY (event_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_event_parts_part ON event_parts(part_id);

CREATE TABLE IF NOT EXISTS part_tags (
    part_id TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (part_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_part_tags_tag ON part_tags(tag);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class DB:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)
            self._migrate(c)

    @staticmethod
    def _migrate(c: sqlite3.Connection) -> None:
        """Idempotent column additions for existing databases."""
        migrations = [
            "ALTER TABLE parts ADD COLUMN status TEXT",
        ]
        for stmt in migrations:
            try:
                c.execute(stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    raise

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        try:
            yield c
        finally:
            c.close()

    # ---- meta ----
    def get_meta(self, key: str) -> Optional[str]:
        with self.conn() as c:
            r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    # ---- members / sessions / invites (identical pattern to Thymeline) ----
    def create_member(self, m: dict) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO members(id,name,color,device,is_owner,joined_at) "
                "VALUES(?,?,?,?,?,?)",
                (m["id"], m["name"], m["color"], m.get("device"),
                 1 if m.get("is_owner") else 0, m["joined_at"]),
            )

    def list_members(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT * FROM members ORDER BY is_owner DESC, joined_at ASC"
            ).fetchall()
            return [self._row_to_member(r) for r in rows]

    def get_member(self, member_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM members WHERE id=?", (member_id,)).fetchone()
            return self._row_to_member(r) if r else None

    @staticmethod
    def _row_to_member(r) -> dict:
        return {
            "id": r["id"], "name": r["name"], "color": r["color"],
            "device": r["device"], "is_owner": bool(r["is_owner"]),
            "joined_at": r["joined_at"],
        }

    def member_count(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) AS n FROM members").fetchone()["n"]

    def create_session(self, token: str, member_id: str, device: str, now: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO sessions(token,member_id,device,created_at,last_seen) "
                "VALUES(?,?,?,?,?)", (token, member_id, device, now, now),
            )

    def touch_session(self, token: str, now: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute(
                "SELECT s.token,s.member_id,m.name,m.color,m.is_owner "
                "FROM sessions s JOIN members m ON m.id = s.member_id "
                "WHERE s.token=?", (token,),
            ).fetchone()
            if not r:
                return None
            c.execute("UPDATE sessions SET last_seen=? WHERE token=?", (now, token))
            return {
                "token": r["token"], "id": r["member_id"], "name": r["name"],
                "color": r["color"], "is_owner": bool(r["is_owner"]),
            }

    def create_invite(self, token: str, created_by: str, now: str) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT INTO invites(token,created_by,created_at) VALUES(?,?,?)",
                (token, created_by, now),
            )

    def consume_invite(self, token: str, used_by: str, now: str) -> bool:
        with self.conn() as c:
            r = c.execute(
                "SELECT used_at FROM invites WHERE token=?", (token,),
            ).fetchone()
            if not r or r["used_at"]:
                return False
            c.execute(
                "UPDATE invites SET used_at=?, used_by=? WHERE token=?",
                (now, used_by, token),
            )
            return True

    # ---- parts ----
    def upsert_part(self, p: dict) -> None:
        with self.conn() as c:
            c.execute(
                """INSERT INTO parts
                   (id,name,category,supplier,link,unit,unit_cost_cents,
                    on_hand,on_order,target_min,status,notes,image,tags,assets,
                    file_path,created_at,updated_at,created_by)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, category=excluded.category,
                     supplier=excluded.supplier, link=excluded.link,
                     unit=excluded.unit, unit_cost_cents=excluded.unit_cost_cents,
                     on_hand=excluded.on_hand, on_order=excluded.on_order,
                     target_min=excluded.target_min, status=excluded.status,
                     notes=excluded.notes,
                     image=excluded.image, tags=excluded.tags,
                     assets=excluded.assets, file_path=excluded.file_path,
                     updated_at=excluded.updated_at""",
                (
                    p["id"], p["name"], p.get("category"), p.get("supplier"),
                    p.get("link"), p.get("unit", "each"), p.get("unit_cost_cents"),
                    p.get("on_hand", 0), p.get("on_order", 0), p.get("target_min", 0),
                    p.get("status"),
                    p.get("notes", ""), p.get("image"),
                    json.dumps(p.get("tags") or []),
                    json.dumps(p.get("assets") or []),
                    p["file_path"], p["created_at"], p["updated_at"],
                    p.get("created_by"),
                ),
            )
            c.execute("DELETE FROM part_tags WHERE part_id=?", (p["id"],))
            for t in p.get("tags") or []:
                c.execute(
                    "INSERT OR IGNORE INTO part_tags(part_id,tag) VALUES(?,?)",
                    (p["id"], t),
                )

    def delete_part(self, part_id: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM parts WHERE id=?", (part_id,))

    def list_parts(
        self,
        q: Optional[str] = None,
        category: Optional[str] = None,
        tag: Optional[str] = None,
        status: Optional[str] = None,
        low_stock: bool = False,
        sort: str = "name",
    ) -> list[dict]:
        sql = "SELECT * FROM parts WHERE 1=1"
        args: list = []
        if q:
            sql += " AND (name LIKE ? OR supplier LIKE ? OR notes LIKE ?)"
            args += [f"%{q}%"] * 3
        if category:
            sql += " AND category = ?"
            args.append(category)
        if tag:
            sql += " AND id IN (SELECT part_id FROM part_tags WHERE tag = ?)"
            args.append(tag)
        if status:
            sql += " AND status = ?"
            args.append(status)
        if low_stock:
            sql += " AND on_hand < target_min AND target_min > 0"
        sort_map = {
            "name": "name COLLATE NOCASE ASC",
            "name_desc": "name COLLATE NOCASE DESC",
            "qty": "on_hand DESC",
            "qty_asc": "on_hand ASC",
            "cost": "(unit_cost_cents * on_hand) DESC",
            "updated": "updated_at DESC",
        }
        sql += f" ORDER BY {sort_map.get(sort, sort_map['name'])}"
        with self.conn() as c:
            rows = c.execute(sql, args).fetchall()
            return [self._row_to_part(r) for r in rows]

    def get_part(self, part_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM parts WHERE id=?", (part_id,)).fetchone()
            return self._row_to_part(r) if r else None

    @staticmethod
    def _row_to_part(r) -> dict:
        # Defensive: status column may not exist on very old DBs that pre-date
        # the migration (shouldn't happen since __init__ runs it, but safe).
        try:
            status = r["status"]
        except (KeyError, IndexError):
            status = None
        return {
            "id": r["id"], "name": r["name"], "category": r["category"],
            "supplier": r["supplier"], "link": r["link"], "unit": r["unit"],
            "unit_cost_cents": r["unit_cost_cents"],
            "on_hand": r["on_hand"], "on_order": r["on_order"],
            "target_min": r["target_min"], "status": status,
            "notes": r["notes"], "image": r["image"],
            "tags": json.loads(r["tags"] or "[]"),
            "assets": json.loads(r["assets"] or "[]"),
            "file_path": r["file_path"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
            "created_by": r["created_by"],
        }

    def adjust_part_qty(self, part_id: str, on_hand_delta: float = 0,
                         on_order_delta: float = 0, now: str = "") -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE parts SET on_hand = MAX(0, on_hand + ?), "
                "                 on_order = MAX(0, on_order + ?), "
                "                 updated_at = ? "
                "WHERE id = ?",
                (on_hand_delta, on_order_delta, now, part_id),
            )

    def set_part_qty(self, part_id: str, on_hand: Optional[float] = None,
                     on_order: Optional[float] = None, now: str = "") -> None:
        fields = []
        args = []
        if on_hand is not None:
            fields.append("on_hand = ?"); args.append(max(0, on_hand))
        if on_order is not None:
            fields.append("on_order = ?"); args.append(max(0, on_order))
        if not fields:
            return
        fields.append("updated_at = ?"); args.append(now)
        args.append(part_id)
        with self.conn() as c:
            c.execute(f"UPDATE parts SET {', '.join(fields)} WHERE id = ?", args)

    # ---- events ----
    def create_event(self, e: dict, lines: list[dict]) -> None:
        with self.conn() as c:
            c.execute(
                """INSERT INTO events
                   (id,type,status,supplier,tracking_url,expected_arrival,
                    cost_cents,body,author_id,file_path,assets,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    e["id"], e["type"], e.get("status"), e.get("supplier"),
                    e.get("tracking_url"), e.get("expected_arrival"),
                    e.get("cost_cents"), e.get("body", ""), e["author_id"],
                    e["file_path"], json.dumps(e.get("assets") or []),
                    e["created_at"], e["updated_at"],
                ),
            )
            for ln in lines:
                c.execute(
                    "INSERT OR REPLACE INTO event_parts(event_id,part_id,qty,unit_cost_cents) "
                    "VALUES(?,?,?,?)",
                    (e["id"], ln["part_id"], ln["qty"], ln.get("unit_cost_cents")),
                )

    def update_event(self, e: dict, lines: Optional[list[dict]] = None) -> None:
        with self.conn() as c:
            c.execute(
                """UPDATE events SET
                     type=?, status=?, supplier=?, tracking_url=?,
                     expected_arrival=?, cost_cents=?, body=?, file_path=?,
                     assets=?, updated_at=?
                   WHERE id=?""",
                (
                    e["type"], e.get("status"), e.get("supplier"),
                    e.get("tracking_url"), e.get("expected_arrival"),
                    e.get("cost_cents"), e.get("body", ""), e["file_path"],
                    json.dumps(e.get("assets") or []), e["updated_at"], e["id"],
                ),
            )
            if lines is not None:
                c.execute("DELETE FROM event_parts WHERE event_id=?", (e["id"],))
                for ln in lines:
                    c.execute(
                        "INSERT INTO event_parts(event_id,part_id,qty,unit_cost_cents) "
                        "VALUES(?,?,?,?)",
                        (e["id"], ln["part_id"], ln["qty"], ln.get("unit_cost_cents")),
                    )

    def delete_event(self, event_id: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM events WHERE id=?", (event_id,))

    def list_events(
        self,
        limit: int = 200,
        before: Optional[str] = None,
        type_: Optional[str] = None,
        status: Optional[str] = None,
        part_id: Optional[str] = None,
        author: Optional[str] = None,
    ) -> list[dict]:
        sql = """SELECT e.* FROM events e WHERE 1=1"""
        args: list = []
        if before:
            sql += " AND e.created_at < ?"; args.append(before)
        if type_:
            sql += " AND e.type = ?"; args.append(type_)
        if status:
            sql += " AND e.status = ?"; args.append(status)
        if author:
            sql += " AND e.author_id = ?"; args.append(author)
        if part_id:
            sql += " AND e.id IN (SELECT event_id FROM event_parts WHERE part_id = ?)"
            args.append(part_id)
        sql += " ORDER BY e.created_at DESC LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            events = [self._row_to_event(r) for r in c.execute(sql, args).fetchall()]
            for ev in events:
                ev["lines"] = self._lines_for_event(c, ev["id"])
            return events

    def get_event(self, event_id: str) -> Optional[dict]:
        with self.conn() as c:
            r = c.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            if not r:
                return None
            ev = self._row_to_event(r)
            ev["lines"] = self._lines_for_event(c, event_id)
            return ev

    @staticmethod
    def _lines_for_event(c, event_id: str) -> list[dict]:
        rows = c.execute(
            "SELECT ep.part_id, ep.qty, ep.unit_cost_cents, p.name, p.unit "
            "FROM event_parts ep LEFT JOIN parts p ON p.id = ep.part_id "
            "WHERE ep.event_id = ?",
            (event_id,),
        ).fetchall()
        return [
            {"part_id": r["part_id"], "qty": r["qty"],
             "unit_cost_cents": r["unit_cost_cents"],
             "part_name": r["name"], "unit": r["unit"]}
            for r in rows
        ]

    @staticmethod
    def _row_to_event(r) -> dict:
        return {
            "id": r["id"], "type": r["type"], "status": r["status"],
            "supplier": r["supplier"], "tracking_url": r["tracking_url"],
            "expected_arrival": r["expected_arrival"],
            "cost_cents": r["cost_cents"], "body": r["body"],
            "author_id": r["author_id"], "file_path": r["file_path"],
            "assets": json.loads(r["assets"] or "[]"),
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        }

    # ---- aggregates / stats ----
    def categories(self) -> list[str]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT category, COUNT(*) AS n FROM parts "
                "WHERE category IS NOT NULL AND category != '' "
                "GROUP BY category ORDER BY n DESC, category ASC"
            ).fetchall()
            return [r["category"] for r in rows]

    def all_tags(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT tag, COUNT(*) AS n FROM part_tags "
                "GROUP BY tag ORDER BY n DESC, tag ASC"
            ).fetchall()
            return [{"tag": r["tag"], "count": r["n"]} for r in rows]

    def part_count(self) -> int:
        with self.conn() as c:
            return c.execute("SELECT COUNT(*) AS n FROM parts").fetchone()["n"]

    def total_stock_value_cents(self) -> int:
        with self.conn() as c:
            r = c.execute(
                "SELECT COALESCE(SUM(on_hand * unit_cost_cents), 0) AS v FROM parts "
                "WHERE unit_cost_cents IS NOT NULL"
            ).fetchone()
            return int(r["v"] or 0)

    def total_spent_cents(self) -> int:
        with self.conn() as c:
            r = c.execute(
                "SELECT COALESCE(SUM(cost_cents), 0) AS v FROM events "
                "WHERE type IN ('order','arrival') AND cost_cents IS NOT NULL"
            ).fetchone()
            return int(r["v"] or 0)

    def in_transit_cents(self) -> int:
        with self.conn() as c:
            r = c.execute(
                "SELECT COALESCE(SUM(cost_cents), 0) AS v FROM events "
                "WHERE type = 'order' AND status IN ('placed','in_transit') "
                "AND cost_cents IS NOT NULL"
            ).fetchone()
            return int(r["v"] or 0)

    def spend_by_month(self, limit: int = 12) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT substr(created_at,1,7) AS month, "
                "       COALESCE(SUM(cost_cents),0) AS spent_cents, "
                "       COUNT(*) AS n "
                "FROM events WHERE type IN ('order','arrival') AND cost_cents IS NOT NULL "
                "GROUP BY month ORDER BY month DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [
                {"month": r["month"], "spent_cents": r["spent_cents"], "events": r["n"]}
                for r in rows
            ]

    def spend_by_category(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT COALESCE(p.category,'(uncategorized)') AS category, "
                "       COALESCE(SUM(ep.qty * ep.unit_cost_cents), 0) AS spent_cents "
                "FROM event_parts ep "
                "JOIN events e ON e.id = ep.event_id "
                "JOIN parts p ON p.id = ep.part_id "
                "WHERE e.type IN ('order','arrival') AND ep.qty > 0 AND ep.unit_cost_cents IS NOT NULL "
                "GROUP BY category ORDER BY spent_cents DESC"
            ).fetchall()
            return [{"category": r["category"], "spent_cents": int(r["spent_cents"])} for r in rows]

    def in_transit_orders(self) -> list[dict]:
        events = self.list_events(limit=200, type_="order")
        return [e for e in events if e["status"] in ("placed", "in_transit")]
