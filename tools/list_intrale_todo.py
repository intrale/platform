#!/usr/bin/env python3
"""Utilidad para listar las historias del proyecto Intrale en estado "Todo"."""
from __future__ import annotations

import json
import os
import sys
import textwrap
import urllib.request

PROJECT_ID = os.environ.get("INTRALE_PROJECT_ID", "PVT_kwDOBTzBoc4AyMGf")
STATUS_FIELD_ID = os.environ.get("INTRALE_STATUS_FIELD_ID", "PVTSSF_lADOBTzBoc4AyMGfzgoLqjg")
STATUS_OPTION_TODO = os.environ.get("INTRALE_STATUS_TODO", "57a3a001")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")

API_URL = "https://api.github.com/graphql"

QUERY = textwrap.dedent(
    """
    query($project:ID!, $cursor:String) {
      node(id: $project) {
        ... on ProjectV2 {
          items(first: 50, after: $cursor) {
            nodes {
              id
              content {
                __typename
                ... on Issue {
                  number
                  title
                  url
                  repository { name }
                }
              }
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    optionId
                    name
                    field { ... on ProjectV2FieldCommon { id } }
                  }
                }
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
    """
)


def _request(payload: dict) -> dict:
    if not GITHUB_TOKEN:
        raise SystemExit("GITHUB_TOKEN no está definido en el entorno")

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API_URL, data=data)
    req.add_header("Authorization", f"Bearer {GITHUB_TOKEN}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as response:
        body = response.read()
    result = json.loads(body)
    if "errors" in result:
        raise SystemExit(json.dumps(result["errors"], indent=2, ensure_ascii=False))
    return result


def _extract_todo(items: list[dict]) -> list[tuple[int, str, str]]:
    selected: list[tuple[int, str, str]] = []
    for item in items:
        content = item.get("content") or {}
        if content.get("__typename") != "Issue":
            continue
        status_nodes = item.get("fieldValues", {}).get("nodes", [])
        has_todo = any(
            node.get("__typename") == "ProjectV2ItemFieldSingleSelectValue"
            and node.get("field", {}).get("id") == STATUS_FIELD_ID
            and node.get("optionId") == STATUS_OPTION_TODO
            for node in status_nodes
        )
        if has_todo:
            selected.append((content["number"], content["title"], content["url"]))
    return selected


def fetch_todo_items() -> list[tuple[int, str, str]]:
    cursor: str | None = None
    issues: list[tuple[int, str, str]] = []
    while True:
        payload = {"query": QUERY, "variables": {"project": PROJECT_ID, "cursor": cursor}}
        data = _request(payload)
        project = data["data"]["node"]
        items = project["items"]["nodes"]
        issues.extend(_extract_todo(items))
        page_info = project["items"]["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
    return sorted(issues, key=lambda item: item[0])


def main() -> None:
    issues = fetch_todo_items()
    if not issues:
        print("No hay historias en estado Todo.")
        return

    width = max(len(str(num)) for num, _, _ in issues)
    for number, title, url in issues:
        print(f"#{number:>{width}} — {title}\n    {url}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
