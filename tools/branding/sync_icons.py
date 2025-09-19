#!/usr/bin/env python3
"""Genera los íconos binarios del branding a partir de sus archivos .b64."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACK_DIR = ROOT / "docs/branding/icon-pack"


def decode_file(b64_path: Path) -> tuple[Path, bool]:
    relative = b64_path.relative_to(PACK_DIR)
    target = ROOT / relative.with_suffix("")
    raw = base64.b64decode(b64_path.read_text().strip())
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() == raw:
        return relative, False
    target.write_bytes(raw)
    return relative, True


def main() -> int:
    if not PACK_DIR.exists():
        print(f"⚠️ No existe {PACK_DIR}", file=sys.stderr)
        return 1

    updated = []
    for b64_path in sorted(PACK_DIR.rglob("*.b64")):
        relative, changed = decode_file(b64_path)
        if changed:
            updated.append(relative)

    if updated:
        for item in updated:
            print(f"✅ Generado {item.with_suffix('')}")
    else:
        print("ℹ️ Los íconos ya estaban actualizados")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
