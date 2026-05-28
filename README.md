# INVPART

A local-first inventory manager for hardware projects.
Sibling to [Thymeline](https://github.com/aryasgit/thymeline) — same editorial
design system, same architecture, different domain.

```
every part. every order. every dollar.
```

Tracks parts, orders, arrivals, usage, and money. Single binary'ish:
markdown vault + SQLite index + FastAPI. Hostable on your LAN; teammates
join with a one-click invite link.

## What it tracks

- **Parts** — name, supplier, link, unit cost, on-hand qty, on-order qty,
  reorder threshold, photo, datasheet, tags, free-form notes.
- **Orders** — placed → in-transit → received. Cost rolls up automatically.
  Tracking URL optional.
- **Usage** — every time you pull a part off the shelf for a build, log it.
- **Arrivals** — flips an order's status; on-hand goes up, on-order goes down.
- **Adjustments** — when reality doesn't match the count (miscount, lost,
  damaged), correct it explicitly.

## Four tabs

| Tab | Shows | Main interaction |
|---|---|---|
| **Stock** | Every part in one editorial list | Expand row → notes, files, quick-actions |
| **Activity** | Chronological log of every event | Day-grouped accordion |
| **Pending** | Orders in transit + reorder list | Single-click "mark received" / "order +" |
| **Spend** | Total spent, by month, by category | Editorial bar rows |

## Run

```bash
./run.sh                # http://localhost:8766
PORT=9000 ./run.sh      # custom port
./run.sh /path/to/vault # custom data location
```

First run prompts for inventory name + your name. After that, click **Invite**
in the top-right to add teammates from any device on your LAN.

## Keyboard

- `1` `2` `3` `4` — switch tabs (stock / activity / pending / spend)
- `a` — Add part (jumps to Stock tab + opens form)
- `⌘K` / `Ctrl+K` — focus search
- `Esc` — close any open dialog

## Data layout

```
vault/
├── parts/                              # one .md per part
│   └── dynamixel-xl330_a1b2c3.md
├── events/                             # one .md per event
│   └── 2026-05-28T11-23-00Z_order_x9y8z7.md
├── assets/YYYY/MM/DD/                  # photos, datasheets, invoices
├── project.json                        # inventory name + created date
└── .invpart.db                         # SQLite index (rebuildable)
```

Each part file:

```markdown
---
id: a1b2c3d4
name: Dynamixel XL330-M288-T
category: Actuator
supplier: ROBOTIS
link: https://www.robotis.us/dynamixel-xl330-m288-t/
unit: each
unit_cost_cents: 4990
on_hand: 12
on_order: 6
target_min: 4
tags: [actuator, dynamixel]
assets: []
created: 2026-05-28T11:23:00Z
---

Position+torque, 0.18 N·m at 5V. Hip & knee joints on V2.
```

## Stack

- Backend: FastAPI + SQLite + plain markdown files (Obsidian-compatible)
- Frontend: vanilla HTML/CSS/JS (no build step)
- Design: editorial monochrome — typography on lines, not in boxes
- Multi-user: invite-link + browser-cookie sessions, no passwords

## Sibling project

[Thymeline](https://github.com/aryasgit/thymeline) is the build journal —
progress photos, failures, debug notes. INVPART is the parts catalog.
Run both side-by-side (Thymeline on 8765, INVPART on 8766).
