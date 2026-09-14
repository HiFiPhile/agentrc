#!/usr/bin/env python3
"""Search the Calibre library by metadata and print matching books.

Usage: search.py KEYWORD [KEYWORD...]        all keywords must match (AND)
       search.py --any KEYWORD [KEYWORD...]  any keyword matches (OR)
       search.py --kind reference-manual --limit 20 stm32h7

Matches title, authors, tags, series, publisher, description and stored
filename. Prints the book id to pass to locate.py, a count per document kind,
and the best matches first: reference manuals and errata before application
notes, since a register question is answered by the former.

Exit 0 matched, 1 nothing matched, 2 bad usage or no library.
"""
import argparse
import contextlib
import glob
import os
import re
import sqlite3
import sys
import unicodedata
import urllib.parse

LIB = os.path.realpath(os.path.expanduser(os.environ.get("CALIBRE_LIBRARY") or "~/Documents/calibre-library"))
DB = os.path.join(LIB, "metadata.db")
LIMIT = 10

# Document kinds, most authoritative for a register/erratum question first.
KINDS = ("reference-manual", "errata", "datasheet", "programming-manual",
         "user-manual", "application-note", "schematic", "other")
# Whole tag (normalized) -> kind. Never a substring test: many books carry a
# whole abstract as one tag, and "this application note..." is not a kind.
TAG_KINDS = {
    "errata": "errata", "board errata": "errata",
    "reference manual": "reference-manual",
    "programming manual": "programming-manual",
    "datasheet": "datasheet", "data sheet": "datasheet",
    "user manual": "user-manual", "user guide": "user-manual", "user's guide": "user-manual",
    "application note": "application-note",
    "technical reference": "reference-manual",
    "schematic": "schematic", "schematics": "schematic",
}
# Fallback for untagged books: the vendor prefix that opens the title, then the
# document word. A databook is an IP core's reference manual by another name.
TITLE_KINDS = (
    (r"^rm\d", "reference-manual"), (r"^es\d", "errata"), (r"^ds\d", "datasheet"),
    (r"^um\d", "user-manual"), (r"^pm\d", "programming-manual"), (r"^an\d", "application-note"),
    (r"\berrata\b", "errata"), (r"\breference manual\b", "reference-manual"),
    (r"\bdatabook\b", "reference-manual"), (r"\btechnical reference\b", "reference-manual"),
    (r"\bcore reference\b", "reference-manual"),
    (r"\bprogramming guide\b", "programming-manual"),
    (r"\buser'?s? manual\b", "user-manual"),
    (r"\bdatasheet\b", "datasheet"), (r"\bapplication note\b", "application-note"),
)

# A USB controller core's own documentation is the register reference for every
# MCU that licensed it, and some of it is titled with no document word at all
# ("Mentor MUSBMHDRC USB 2.0 Multi-Point Dual-Role Controller").
CORE_TAGS = ("dwc2", "dwc3", "chipidea", "musb")

QUERY = """
SELECT b.id, b.title, b.path,
       (SELECT group_concat(a.name, ', ') FROM authors a
          JOIN books_authors_link l ON l.author = a.id WHERE l.book = b.id),
       (SELECT group_concat(t.name, ', ') FROM tags t
          JOIN books_tags_link l ON l.tag = t.id WHERE l.book = b.id),
       (SELECT group_concat(s.name, ', ') FROM series s
          JOIN books_series_link l ON l.series = s.id WHERE l.book = b.id),
       (SELECT group_concat(p.name, ', ') FROM publishers p
          JOIN books_publishers_link l ON l.publisher = p.id WHERE l.book = b.id),
       (SELECT c.text FROM comments c WHERE c.book = b.id),
       (SELECT group_concat(d.format || '/' || d.name, char(10)) FROM data d WHERE d.book = b.id)
FROM books b
"""

_authors = None


def norm(s):
    # NFKC + casefold so MICRO SIGN/GREEK MU, curly quotes and dashes compare equal.
    return unicodedata.normalize("NFKC", s).casefold()


def tag_list(tags):
    """Calibre joins tags with ', '; normalize each for whole-tag comparison."""
    return [re.sub(r"[-_\s]+", " ", norm(t)).strip() for t in (tags or "").split(", ") if t.strip()]


def kind_of(title, tags):
    """The document kind, from an exact tag, else the title, else "other".

    Kinds are tried in KINDS order so a book tagged both "errata" and
    "datasheet" classifies the same way whatever order Calibre returns.
    """
    named = tag_list(tags)
    kinds = {TAG_KINDS[t] for t in named if t in TAG_KINDS}
    if kinds:
        return min(kinds, key=KINDS.index)
    t = norm(title)
    for pattern, kind in TITLE_KINDS:
        if re.search(pattern, t):
            return kind
    return "reference-manual" if set(CORE_TAGS) & set(named) else "other"


def resolve(bid, path, fmt, name):
    """Absolute path of one format row, or None if the file is not on disk.

    Calibre renames `<author>/<title> (<id>)` when metadata is edited and leaves
    the old directory behind, so on a miss retry by the stable book id.
    """
    ext = "." + fmt.lower()
    exact = os.path.join(LIB, path, name + ext)
    if os.path.exists(exact):
        return exact
    global _authors
    if _authors is None:
        _authors = {}
        for d in os.listdir(LIB):  # case-only duplicates exist on a case-sensitive mount
            _authors.setdefault(d.lower(), []).append(d)
    for author in _authors.get(path.split("/")[0].lower(), ()):
        for d in glob.glob(os.path.join(glob.escape(os.path.join(LIB, author)), "* (%d)" % bid)):
            for f in sorted(glob.glob(os.path.join(glob.escape(d), "*" + ext))):
                return f
    return None


def parser():
    p = argparse.ArgumentParser(prog="search.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("keyword", nargs="*")
    p.add_argument("--any", action="store_true", help="any keyword matches, instead of all")
    p.add_argument("--kind", choices=KINDS, help="only this document kind")
    p.add_argument("--limit", type=int, default=LIMIT, help="how many to print (0 for all)")
    p.add_argument("--path", action="store_true", help="print each result's file path")
    return p


def main(argv):
    args = parser().parse_args(argv)
    keywords = [norm(k) for k in args.keyword]
    if not keywords:
        parser().print_help(sys.stderr)
        return 2
    if args.limit < 0:
        print("--limit cannot be negative", file=sys.stderr)
        return 2
    if not os.path.exists(DB):
        print(f"no Calibre database at {DB}", file=sys.stderr)
        return 2

    with contextlib.closing(sqlite3.connect("file:" + urllib.parse.quote(DB) + "?mode=ro",
                                            uri=True)) as db:
        rows = db.execute(QUERY).fetchall()
    hits = []
    for bid, title, path, authors, tags, series, publisher, comments, files in rows:
        entries = [e.split("/", 1) for e in (files or "").split("\n") if e]
        hay = norm(" ".join(x for x in (title, authors, tags, series, publisher, comments) if x)
                   + " " + " ".join(n for _, n in entries))
        found = sum(k in hay for k in keywords)
        if not found or (not args.any and found < len(keywords)):
            continue
        kind = kind_of(title, tags)
        if args.kind and kind != args.kind:
            continue
        in_title = sum(k in norm(title) for k in keywords)
        hits.append((KINDS.index(kind), -found, -in_title, title, kind, bid, tags, path, entries))

    if not hits:
        print("no match")
        return 1

    hits.sort(key=lambda h: h[:4])  # tags/path are not comparable across rows
    counts = {}
    for h in hits:
        counts[h[4]] = counts.get(h[4], 0) + 1
    shown = hits if args.limit == 0 else hits[:args.limit]
    print(f"{len(hits)} book(s): " + ", ".join(f"{n} {k}" for k, n in
                                               sorted(counts.items(), key=lambda c: KINDS.index(c[0]))))
    if len(shown) < len(hits):
        print(f"showing {len(shown)}; --limit N for more, --kind K to filter, or add a keyword")
    for _, _, _, title, kind, bid, tags, path, entries in shown:
        # Some books carry a whole abstract as one "tag"; the line is a label, not the metadata.
        label = (tags or "")[:60].rstrip(", ")
        print(f"{bid}  {title[:96]}  [{kind}]" + (f"  {label}" if label else ""))
        if args.path and not entries:
            print("  (no file in this library)")
        for fmt, name in entries if args.path else ():
            p = resolve(bid, path, fmt, name)
            print(f"  {fmt} {p}" if p else f"  {fmt} MISSING (library mid-sync or file deleted)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)
