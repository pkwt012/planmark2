"""Legend sheet and a compact legend block that can sit on a plan."""

from __future__ import annotations

import math

import pymupdf

from elecplan.export import clean_amps, clean_height, export_pdf


def _legend_id(raw) -> str:
    if not isinstance(raw, str):
        raise ValueError("bad symbols")
    sid = raw.strip()
    if not sid or len(sid) > 80 or any(ord(ch) < 32 for ch in sid):
        raise ValueError("bad symbols")
    return sid


def _legend_note(sym: dict, suffix: str):
    """A height, an ampacity, or both, matching the text the editor sends."""
    from elecplan.export import takes_amps, takes_height

    suffix = suffix.strip()
    if takes_height(sym) and takes_amps(sym) and " " in suffix:
        height_raw, amps_raw = suffix.split(" ", 1)
        try:
            height = clean_height(height_raw)
            amps = clean_amps(amps_raw)
        except ValueError:
            height = amps = None
        if height and amps and suffix == f"{height} {amps}":
            return f"{height} {amps}"
    if takes_height(sym):
        try:
            height = clean_height(suffix)
        except ValueError:
            height = None
        if height and suffix == height:
            return height
    if takes_amps(sym):
        try:
            amps = clean_amps(suffix)
        except ValueError:
            amps = None
        if amps and suffix == amps:
            return amps
    return None


def _named_legend_symbol(sym: dict, raw_name) -> dict:
    """Keep the catalog name, or that name plus a height or an ampacity."""
    base = str(sym.get("name") or "")
    if raw_name is None or raw_name == base:
        return sym
    if not isinstance(raw_name, str):
        raise ValueError("bad symbols")
    prefix = base + " "
    if not raw_name.startswith(prefix):
        raise ValueError("bad symbols")
    note = _legend_note(sym, raw_name[len(prefix):])
    if not note or raw_name != f"{base} {note}":
        raise ValueError("bad symbols")
    return {**sym, "name": f"{base} {note}"}


def choose_legend_symbols(symbols: list[dict], symbol_ids, names=None) -> list[dict]:
    """Catalog entries for the symbols on the plan.

    Unknown ids are skipped. An empty result is refused so a legend sheet
    is not a blank page. Without names, the result is one row per id in
    catalog order. With names, each id can repeat for a different outlet height,
    in the order given.
    """
    if symbol_ids is None:
        symbol_ids = []
    if not isinstance(symbol_ids, list):
        raise ValueError("bad symbols")
    if len(symbol_ids) > 500:
        raise ValueError("too many symbols")
    if names is None:
        wanted = {_legend_id(raw) for raw in symbol_ids}
        chosen = [sym for sym in symbols if sym.get("id") in wanted]
        if not chosen:
            raise ValueError("There are no symbols on the plan to list")
        return chosen
    if not isinstance(names, list) or len(names) != len(symbol_ids):
        raise ValueError("bad symbols")
    by_id = {}
    for sym in symbols:
        sid = sym.get("id")
        if isinstance(sid, str):
            by_id.setdefault(sid, sym)
    chosen = []
    for raw, raw_name in zip(symbol_ids, names):
        sym = by_id.get(_legend_id(raw))
        if sym is None:
            continue
        chosen.append(_named_legend_symbol(sym, raw_name))
    if not chosen:
        raise ValueError("There are no symbols on the plan to list")
    return chosen


def build_legend_pdf(symbols: list[dict], width: float, height: float) -> bytes:
    """One or more pages matching the plan sheet, listing the whole library."""
    width = float(width)
    height = float(height)
    if width < 240 or height < 240:
        width, height = 792.0, 612.0

    cols = 3 if width >= 700 else 2
    margin = 36.0
    header = 52.0
    footer = 28.0
    row_h = 56.0
    usable = height - header - footer
    rows = max(1, int(usable // row_h))
    per_page = cols * rows
    page_count = max(1, math.ceil(len(symbols) / per_page))
    col_w = (width - margin * 2) / cols
    symbol_size = min(32.0, row_h * 0.62)

    doc = pymupdf.open()
    placements = []
    by_id = {item["id"]: item for item in symbols}
    try:
        for page_index in range(page_count):
            page = doc.new_page(width=width, height=height)
            page.insert_text(
                pymupdf.Point(margin, 34),
                "SYMBOL LEGEND",
                fontsize=16,
                fontname="helv",
                color=(0.08, 0.08, 0.08),
            )
            if page_count > 1:
                label = f"{page_index + 1} of {page_count}"
                page.insert_text(
                    pymupdf.Point(width - margin - 52, 32),
                    label,
                    fontsize=10,
                    fontname="helv",
                    color=(0.35, 0.35, 0.35),
                )
            chunk = symbols[page_index * per_page : (page_index + 1) * per_page]
            for index, sym in enumerate(chunk):
                col = index % cols
                row = index // cols
                cx = margin + col * col_w + symbol_size * 0.55
                cy = header + row * row_h + row_h * 0.38
                placements.append(
                    {
                        "symbolId": sym["id"],
                        "page": page_index,
                        "x": cx,
                        "y": cy,
                        "size": symbol_size,
                        "rotation": 0,
                        "color": sym.get("defaultColor") or "#141414",
                    }
                )
                text_x = cx + symbol_size * 0.7
                page.insert_text(
                    pymupdf.Point(text_x, cy - 2),
                    sym["name"],
                    fontsize=10,
                    fontname="helv",
                    color=(0.1, 0.1, 0.1),
                )
                hint = (sym.get("legend") or sym.get("hint") or "").strip()
                if hint and hint.lower() == str(sym.get("name") or "").strip().lower():
                    hint = ""
                if hint:
                    page.insert_text(
                        pymupdf.Point(text_x, cy + 12),
                        hint[:90],
                        fontsize=7.5,
                        fontname="helv",
                        color=(0.35, 0.35, 0.35),
                    )
        raw = doc.tobytes()
    finally:
        doc.close()
    return export_pdf(raw, placements, by_id)


def legend_layout(symbols: list[dict]) -> dict:
    """Positions for a compact key: glyph plus name, in catalog order.

    Width and height are PDF points. The same numbers drive the on-screen
    block and the stamped PDF, so the two stay aligned.
    """
    name_size = 9.0
    sym_size = 26.0
    gap = 6.0
    slack = 10.0
    row_h = 36.0
    pad = 14.0
    gutter = 14.0
    header = 38.0
    title = {
        "text": "SYMBOL LEGEND",
        "x": pad,
        "y": 26.0,
        "size": 13.0,
        "weight": "bold",
    }
    if not symbols:
        return {"width": 240.0, "height": 72.0, "items": [], "labels": [title]}

    name_w = slack + max(
        pymupdf.get_text_length(sym["name"], fontname="helv", fontsize=name_size) for sym in symbols
    )
    col_w = sym_size + gap + name_w
    count = len(symbols)
    cols = 1
    if count >= 12 and (col_w * 4 + gutter * 3 + pad * 2) <= 920:
        cols = 4
    elif count >= 6 and (col_w * 3 + gutter * 2 + pad * 2) <= 760:
        cols = 3
    elif count >= 2:
        cols = 2
    cols = max(1, min(cols, count))
    rows = math.ceil(count / cols)
    width = pad * 2 + cols * col_w + (cols - 1) * gutter
    height = header + rows * row_h + pad

    items = []
    labels = [title]
    for index, sym in enumerate(symbols):
        col = index % cols
        row = index // cols
        cx = pad + col * (col_w + gutter) + sym_size / 2
        cy = header + row * row_h + row_h / 2
        items.append(
            {
                "id": sym["id"],
                "name": sym["name"],
                "x": round(cx, 2),
                "y": round(cy, 2),
                "size": sym_size,
                "color": sym.get("defaultColor") or "#141414",
            }
        )
        labels.append(
            {
                "text": sym["name"],
                "x": round(cx + sym_size / 2 + gap, 2),
                "y": round(cy + name_size * 0.35, 2),
                "size": name_size,
                "weight": "regular",
            }
        )
    return {
        "width": round(width, 2),
        "height": round(height, 2),
        "items": items,
        "labels": labels,
    }


def build_legend_block(symbols: list[dict]) -> tuple[bytes, float, float]:
    """A tight PDF of the whole key. Returns bytes plus its width and height."""
    layout = legend_layout(symbols)
    width = float(layout["width"])
    height = float(layout["height"])
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=width, height=height)
        page.draw_rect(
            pymupdf.Rect(0.6, 0.6, width - 0.6, height - 0.6),
            color=(0.22, 0.22, 0.22),
            fill=(1, 1, 1),
            width=1.0,
        )
        for label in layout["labels"]:
            font = "hebo" if label.get("weight") == "bold" else "helv"
            page.insert_text(
                pymupdf.Point(label["x"], label["y"]),
                label["text"],
                fontsize=float(label["size"]),
                fontname=font,
                color=(0.08, 0.08, 0.08),
            )
        raw = doc.tobytes()
    finally:
        doc.close()
    by_id = {item["id"]: item for item in symbols}
    placements = [
        {
            "kind": "symbol",
            "symbolId": entry["id"],
            "page": 0,
            "x": entry["x"],
            "y": entry["y"],
            "size": entry["size"],
            "rotation": 0,
            "color": entry["color"],
        }
        for entry in layout["items"]
    ]
    return export_pdf(raw, placements, by_id), width, height
