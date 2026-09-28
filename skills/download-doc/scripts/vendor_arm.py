#!/usr/bin/env python3
"""Arm adapter (architecture and debug-interface specifications).

developer.arm.com answers scripted requests with an Akamai 403, but the documentation
service behind it serves the same catalogue as JSON: `/documentation/<code>/latest`
carries the title, the revision label (`B.z`, `E.e`, `H`) and a `resources` list whose
PDF entry downloads without a login (`?token=` left empty).

There is no listing worth enumerating for this library, so CATALOGUE names the
documents; one Arm publishes under another code is invisible here. A listed code the
service no longer answers with a PDF is an error, not a skip.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from doclib import Doc, get_json   # noqa: E402

USB_SCOPE = "all"
USB_SCOPE_NOTE = "architecture and debug specifications, not parts, so nothing is excluded"

API = "https://documentation-service.arm.com/documentation"
# The hand-filed Arm books in this library carry this author, and legacy matching
# searches by it.
AUTHOR = "ARM Limited"

# code, kind, families
CATALOGUE = [
    ("ddi0419", "reference-manual", ["Cortex-M", "Armv6-M"]),
    ("ddi0403", "reference-manual", ["Cortex-M", "Armv7-M"]),
    ("ddi0553", "reference-manual", ["Cortex-M", "Armv8-M"]),
    ("ihi0031", "reference-manual", ["CoreSight", "ADIv5"]),
]


def enumerate_docs(families=None, types=None) -> list:
    want = {f.lower() for f in families} if families else None
    docs = []
    for code, kind, fams in CATALOGUE:
        if types and kind not in types:
            continue
        if want and not any(f.lower() in want for f in fams):
            continue
        meta = get_json(f"{API}/{code}/latest")
        pdf = next((r["href"] for r in meta.get("_links", {}).get("resources", [])
                    if r.get("extension") == "pdf"), None)
        if not pdf:
            raise SystemExit(f"arm: {code} has no PDF resource at {API}/{code}/latest")
        title = meta["title"]
        docs.append(Doc(
            vendor="arm", doc_id=code.upper(), doc_type=kind,
            version=meta.get("versionLabel"), title=title, url=pdf, author=AUTHOR,
            family=list(fams), desc=title,
            # The earlier copies were filed by hand under the cover title.
            aliases=[title]))
    return docs


if __name__ == "__main__":
    for d in enumerate_docs():
        print(f"  {d.doc_id:<10} {d.version or '?':<5} {d.title}")
