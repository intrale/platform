#!/usr/bin/env python3
"""Genera ios/Branding.xcconfig a partir de la plantilla y overrides."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple

BRANDING_KEYS = [
    "BRAND_ID",
    "BUNDLE_ID_SUFFIX",
    "BRAND_NAME",
    "DEEPLINK_HOST",
    "BRANDING_ENDPOINT",
    "BRANDING_PREVIEW_VERSION",
    "PRODUCT_BUNDLE_IDENTIFIER",
    "DISPLAY_NAME",
]

_ASSIGNMENT_RE = re.compile(r"^([A-Z0-9_]+)\s*=\s*(.*)$")


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Genera Branding.xcconfig en base a BrandingTemplate.xcconfig y a "
            "los parámetros recibidos por entorno o mediante --set"
        )
    )
    parser.add_argument(
        "--template",
        type=Path,
        required=True,
        help="Ruta al archivo BrandingTemplate.xcconfig",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Ruta destino del archivo Branding.xcconfig",
    )
    parser.add_argument(
        "--set",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Override explícito del valor de una clave",
    )
    return parser.parse_args()


def _load_template(path: Path) -> Tuple[List[Tuple[str, str]], Dict[str, str]]:
    if not path.exists():
        raise FileNotFoundError(f"No se encontró la plantilla: {path}")

    entries: List[Tuple[str, str]] = []
    defaults: Dict[str, str] = {}

    with path.open("r", encoding="utf-8") as fh:
        for raw_line in fh.readlines():
            stripped = raw_line.strip()
            match = _ASSIGNMENT_RE.match(stripped)
            if not stripped or stripped.startswith("//") or match is None:
                entries.append(("raw", raw_line))
                continue

            key, value = match.group(1), match.group(2).strip()
            entries.append(("setting", key))
            defaults[key] = value

    return entries, defaults


def _parse_overrides(raw_overrides: List[str]) -> Dict[str, str]:
    overrides: Dict[str, str] = {}
    for item in raw_overrides:
        if "=" not in item:
            raise ValueError(
                f"El parámetro '{item}' no respeta el formato KEY=VALUE requerido por --set"
            )
        key, value = item.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in BRANDING_KEYS:
            raise KeyError(f"'{key}' no es una clave soportada para Branding.xcconfig")
        overrides[key] = value
    return overrides


def _value_from_environment(key: str) -> str | None:
    value = os.environ.get(key)
    if value is None:
        return None
    return value.strip()


def _normalize_value(key: str, value: str) -> str:
    if key == "BUNDLE_ID_SUFFIX":
        sanitized = value.replace("\u200b", "").strip()
        if any(ch.isspace() for ch in sanitized):
            raise ValueError("BUNDLE_ID_SUFFIX no puede contener espacios")
        # Evitar prefijos con punto duplicado.
        sanitized = sanitized.lstrip(".")
        return sanitized

    if key == "BRAND_ID":
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("BRAND_ID es obligatorio")
        return sanitized

    if key == "DEEPLINK_HOST":
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("DEEPLINK_HOST es obligatorio")
        return sanitized

    if key == "BRAND_NAME":
        return value.strip()

    if key == "BRANDING_PREVIEW_VERSION":
        return value.strip()

    if key == "BRANDING_ENDPOINT":
        sanitized = value.strip()
        if not sanitized:
            raise ValueError("BRANDING_ENDPOINT es obligatorio")
        return sanitized

    if key == "PRODUCT_BUNDLE_IDENTIFIER":
        return value.strip()

    if key == "DISPLAY_NAME":
        return value.strip()

    return value


def _format_value(value: str) -> str:
    if value == "":
        return ""

    escaped = value.replace("\"", "\\\"")
    if any(ch.isspace() for ch in escaped) or "#" in escaped:
        return f'"{escaped}"'
    return escaped


def main() -> int:
    args = _parse_arguments()

    entries, defaults = _load_template(args.template)
    overrides = _parse_overrides(args.set)

    resolved: Dict[str, str] = {}
    for key in BRANDING_KEYS:
        # Prioridad: override CLI -> variable de entorno -> plantilla -> string vacío.
        if key in overrides:
            value = overrides[key]
        else:
            env_value = _value_from_environment(key)
            if env_value is not None:
                value = env_value
            else:
                if key == "BRAND_ID":
                    raise ValueError(
                        "BRAND_ID debe definirse mediante variable de entorno o --set"
                    )
                value = defaults.get(key, "")

        if value is None:
            value = ""

        resolved[key] = _normalize_value(key, value)

    output_lines: List[str] = []
    for entry_type, payload in entries:
        if entry_type == "raw":
            output_lines.append(payload)
            continue

        key = payload
        value = resolved.get(key, defaults.get(key, ""))
        formatted_value = _format_value(value)
        output_lines.append(f"{key} = {formatted_value}\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as fh:
        fh.writelines(output_lines)

    summary = [
        "Branding.xcconfig generado con parámetros:",
    ]
    for key in BRANDING_KEYS:
        display_value = resolved.get(key, "") or "(vacío)"
        summary.append(f" - {key}: {display_value}")

    print("\n".join(summary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # pragma: no cover - manejo global para logs del pipeline
        print(f"Error generando Branding.xcconfig: {exc}", file=sys.stderr)
        sys.exit(1)
