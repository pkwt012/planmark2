"""A plan sheet that lists circuits, what is on them, and notes."""

from __future__ import annotations

import math

import pymupdf


def _cell(value, limit: int, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"schedule {label} is missing")
    text = " ".join(value.split())
    if not text or len(text) > limit or any(ord(ch) < 32 for ch in text):
        raise ValueError(f"schedule {label} is missing")
    return text


def parse_schedule_rows(raw) -> list[dict]:
    """Circuit rows for a schedule sheet. Empty is not a schedule."""
    if not isinstance(raw, list):
        raise ValueError("schedule must be a list")
    if len(raw) > 400:
        raise ValueError("too many schedule rows")
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("bad schedule row")
        circuit = _cell(item.get("circuit"), 24, "circuit")
        description = _cell(item.get("description"), 160, "description")
        notes = item.get("notes") if item.get("notes") is not None else ""
        if not isinstance(notes, str):
            raise ValueError("bad schedule notes")
        notes = " ".join(notes.split())
        if len(notes) > 160 or any(ord(ch) < 32 for ch in notes):
            raise ValueError("bad schedule notes")
        try:
            count = int(item["count"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("bad schedule count") from exc
        if count < 0 or count > 10000:
            raise ValueError("bad schedule count")
        rows.append(
            {"circuit": circuit, "description": description, "count": count, "notes": notes}
        )
    return rows


def _fit(text: str, fontsize: float, max_width: float, fontname: str = "helv") -> str:
    if pymupdf.get_text_length(text, fontname=fontname, fontsize=fontsize) <= max_width:
        return text
    trimmed = text
    while trimmed and pymupdf.get_text_length(trimmed + "...", fontname=fontname, fontsize=fontsize) > max_width:
        trimmed = trimmed[:-1]
    trimmed = trimmed.rstrip() or text[:1]
    return trimmed + "..."


def build_schedule_pdf(rows: list[dict], width: float, height: float, subtitle: str) -> bytes:
    """One or more pages, the same size as the plan sheet, listing circuits."""
    width = float(width)
    height = float(height)
    if width < 240 or height < 240:
        width, height = 792.0, 612.0
    subtitle = " ".join(str(subtitle or "").split())[:80] or "All sheets"

    margin = 48.0
    top = 86.0
    footer = 36.0
    row_h = 22.0
    size = 11.0
    usable = height - top - footer
    per_page = max(1, int(usable // row_h))
    page_count = max(1, math.ceil(len(rows) / per_page))
    ink = (0.1, 0.1, 0.1)
    quiet = (0.35, 0.35, 0.35)
    available = width - margin * 2
    circuit_w = min(72.0, available * 0.16)
    count_w = 42.0
    notes_w = min(180.0, available * 0.28)
    gap = 12.0
    desc_w = available - circuit_w - count_w - notes_w - gap * 3
    if desc_w < 80:
        notes_w = max(60.0, notes_w - (80 - desc_w))
        desc_w = available - circuit_w - count_w - notes_w - gap * 3

    doc = pymupdf.open()
    try:
        for page_index in range(page_count):
            page = doc.new_page(width=width, height=height)
            page.insert_text(
                pymupdf.Point(margin, 42),
                "PANEL SCHEDULE",
                fontsize=16,
                fontname="helv",
                color=ink,
            )
            page.insert_text(
                pymupdf.Point(margin, 60),
                subtitle,
                fontsize=11,
                fontname="helv",
                color=quiet,
            )
            if page_count > 1:
                label = f"{page_index + 1} of {page_count}"
                label_w = pymupdf.get_text_length(label, fontname="helv", fontsize=10)
                page.insert_text(
                    pymupdf.Point(width - margin - label_w, 40),
                    label,
                    fontsize=10,
                    fontname="helv",
                    color=quiet,
                )
            headers = ("Circuit", "Description", "Count", "Notes")
            widths = (circuit_w, desc_w, count_w, notes_w)
            x = margin
            for header, col_w in zip(headers, widths):
                page.insert_text(
                    pymupdf.Point(x, top - 16),
                    header,
                    fontsize=10,
                    fontname="hebo",
                    color=ink,
                )
                x += col_w + gap
            page.draw_line(
                pymupdf.Point(margin, top - 10),
                pymupdf.Point(width - margin, top - 10),
                color=ink,
                width=0.6,
            )
            chunk = rows[page_index * per_page : (page_index + 1) * per_page]
            for index, row in enumerate(chunk):
                y = top + index * row_h
                circuit = _fit(row["circuit"], size, circuit_w, "hebo")
                description = _fit(row["description"], size, desc_w)
                count = str(row["count"])
                notes = _fit(row["notes"], size, notes_w) if row["notes"] else ""
                page.insert_text(pymupdf.Point(margin, y), circuit, fontsize=size, fontname="hebo", color=ink)
                page.insert_text(
                    pymupdf.Point(margin + circuit_w + gap, y),
                    description,
                    fontsize=size,
                    fontname="helv",
                    color=ink,
                )
                page.insert_text(
                    pymupdf.Point(margin + circuit_w + gap + desc_w + gap, y),
                    count,
                    fontsize=size,
                    fontname="helv",
                    color=ink,
                )
                if notes:
                    page.insert_text(
                        pymupdf.Point(margin + circuit_w + gap + desc_w + gap + count_w + gap, y),
                        notes,
                        fontsize=size,
                        fontname="helv",
                        color=ink,
                    )
        return doc.tobytes()
    finally:
        doc.close()
