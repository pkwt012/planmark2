"""Stamp symbol placements onto a copy of a floor-plan PDF."""

from __future__ import annotations

import json
import math
import re

import pymupdf

from elecplan.library import prepare_svg

REVISE_MARKS = "plan-marks.json"
REVISE_SOURCE = "plan-marks-source.pdf"

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _page_index(item: dict, page_count: int) -> int:
    page = int(item["page"])
    if page < 0 or page >= page_count:
        raise ValueError("page out of range")
    return page


def _color(item: dict) -> str:
    color = item.get("color") or "#141414"
    if not _HEX.fullmatch(str(color)):
        raise ValueError("bad color")
    return str(color).lower()


def _finite(*values: float) -> None:
    if not all(math.isfinite(value) for value in values):
        raise ValueError("non-numeric coordinate")


def _optional_text(value, label: str, limit: int) -> str | None:
    """A short label stored on a mark. Missing or blank is omitted."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"bad {label}")
    text = " ".join(value.split())
    if not text:
        return None
    if len(text) > limit or any(ord(ch) < 32 for ch in text):
        raise ValueError(f"bad {label}")
    return text


_HEIGHT_CHARS = re.compile(r"^[0-9A-Za-z\"'./ -]+$")
_HEIGHT_NUMBER = re.compile(r"^\d{1,3}(?:\.\d)?$")


def clean_height(value) -> str | None:
    """Outlet height. A plain number such as 48 is stored as 48\"."""
    text = _optional_text(value, "height", 12)
    if text is None:
        return None
    if not _HEIGHT_CHARS.fullmatch(text):
        raise ValueError("bad height")
    if _HEIGHT_NUMBER.fullmatch(text):
        text += '"'
    if len(text) > 12:
        raise ValueError("bad height")
    return text


def _height_rank(height: str) -> tuple:
    """Blank first, then by the leading number, so 18\" sits before 48\"."""
    if not height:
        return (0, 0.0, "")
    match = re.match(r"(\d+(?:\.\d+)?)", height)
    if match:
        return (1, float(match.group(1)), height)
    return (2, 0.0, height)


def _mark_extra(item: dict) -> dict:
    extra = {}
    layer = _optional_text(item.get("layer"), "layer", 40)
    circuit = _optional_text(item.get("circuit"), "circuit", 24)
    if layer:
        extra["layer"] = layer
    if circuit:
        extra["circuit"] = circuit
    return extra


def clean_layer_list(raw) -> list[str]:
    """Layer names from an export or legend request. Missing means none hidden."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("bad layers")
    if len(raw) > 40:
        raise ValueError("too many layers")
    names = []
    for item in raw:
        name = _optional_text(item, "layer", 40)
        if name:
            names.append(name)
    return names


def parse_placements(raw, page_count: int, symbol_ids: set[str], run_ids: set[str] | None = None) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError("placements must be a list")
    if len(raw) > 5000:
        raise ValueError("too many symbols (limit 5000)")
    out = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"placement {index} is not an object")
        kind = item.get("kind") or ("symbol" if "symbolId" in item else "")
        extra = {}
        try:
            extra = _mark_extra(item)
            if kind == "line":
                page = _page_index(item, page_count)
                x1, y1 = float(item["x1"]), float(item["y1"])
                x2, y2 = float(item["x2"]), float(item["y2"])
                color = _color(item)
                _finite(x1, y1, x2, y2)
                out.append(
                    {
                        "kind": "line",
                        "page": page,
                        "x1": x1,
                        "y1": y1,
                        "x2": x2,
                        "y2": y2,
                        "color": color,
                        "guide": item.get("guide") is True,
                        **extra,
                    }
                )
                continue
            if kind == "legend":
                page = _page_index(item, page_count)
                x, y = float(item["x"]), float(item["y"])
                width = float(item["width"])
                _finite(x, y, width)
                if not 40 <= width <= 2000:
                    raise ValueError("legend width must be between 40 and 2000 points")
                out.append({"kind": "legend", "page": page, "x": x, "y": y, "width": width, **extra})
                continue
            if kind == "note":
                page = _page_index(item, page_count)
                x, y = float(item["x"]), float(item["y"])
                size = float(item["size"])
                color = _color(item)
                text = _note_text(item.get("text"))
                _finite(x, y, size)
                if not 8 <= size <= 36:
                    raise ValueError("note size must be between 8 and 36 points")
                out.append(
                    {
                        "kind": "note",
                        "page": page,
                        "x": x,
                        "y": y,
                        "text": text,
                        "size": size,
                        "color": color,
                        **extra,
                    }
                )
                continue
            if kind == "arrow":
                page = _page_index(item, page_count)
                x1, y1 = float(item["x1"]), float(item["y1"])
                x2, y2 = float(item["x2"]), float(item["y2"])
                color = _color(item)
                _finite(x1, y1, x2, y2)
                if math.hypot(x2 - x1, y2 - y1) < 4:
                    raise ValueError("arrow is too short")
                out.append(
                    {
                        "kind": "arrow",
                        "page": page,
                        "x1": x1,
                        "y1": y1,
                        "x2": x2,
                        "y2": y2,
                        "color": color,
                        **extra,
                    }
                )
                continue
            if kind == "whitebox":
                page = _page_index(item, page_count)
                x1, y1 = float(item["x1"]), float(item["y1"])
                x2, y2 = float(item["x2"]), float(item["y2"])
                _finite(x1, y1, x2, y2)
                if abs(x2 - x1) < 4 or abs(y2 - y1) < 4:
                    raise ValueError("white box is too small")
                out.append(
                    {
                        "kind": "whitebox",
                        "page": page,
                        "x1": x1,
                        "y1": y1,
                        "x2": x2,
                        "y2": y2,
                        **extra,
                    }
                )
                continue
            if kind == "run":
                page = _page_index(item, page_count)
                sid = item["symbolId"]
                allowed = run_ids if run_ids is not None else set()
                if sid not in symbol_ids or sid not in allowed:
                    raise ValueError(f"unknown run {sid}")
                x1, y1 = float(item["x1"]), float(item["y1"])
                x2, y2 = float(item["x2"]), float(item["y2"])
                color = _color(item)
                _finite(x1, y1, x2, y2)
                if math.hypot(x2 - x1, y2 - y1) < 8:
                    raise ValueError("run is too short")
                out.append(
                    {
                        "kind": "run",
                        "symbolId": sid,
                        "page": page,
                        "x1": x1,
                        "y1": y1,
                        "x2": x2,
                        "y2": y2,
                        "color": color,
                        **extra,
                    }
                )
                continue
            if kind != "symbol":
                raise ValueError(f"unknown kind {kind!r}")
            sid = item["symbolId"]
            if sid not in symbol_ids:
                raise ValueError(f"unknown symbol {sid}")
            page = _page_index(item, page_count)
            x = float(item["x"])
            y = float(item["y"])
            size = float(item["size"])
            rotation = float(item.get("rotation") or 0)
            color = _color(item)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"placement {index}: {exc}") from exc
        _finite(x, y, size, rotation)
        if not 2 <= size <= 500:
            raise ValueError(f"placement {index} size must be between 2 and 500 points")
        parsed = {
            "kind": "symbol",
            "symbolId": sid,
            "page": page,
            "x": x,
            "y": y,
            "size": size,
            "rotation": rotation,
            "color": color,
            **extra,
        }
        if item.get("height") not in (None, ""):
            try:
                parsed["height"] = clean_height(item.get("height"))
            except ValueError as exc:
                raise ValueError(f"placement {index}: {exc}") from exc
        out.append(parsed)
    return out


def _svg_to_pdf(svg: str) -> pymupdf.Document:
    src = pymupdf.open(stream=svg.encode("utf-8"), filetype="svg")
    try:
        pdf_bytes = src.convert_to_pdf()
    finally:
        src.close()
    return pymupdf.open(stream=pdf_bytes, filetype="pdf")


def _baked_rotation(rotation: float, page_rotation: int) -> float:
    """On-screen spin, minus the /Rotate a viewer applies again.

    The editor turns a symbol on the page as shown. Export draws into the
    unrotated page box, and the viewer then honors /Rotate. Subtract that
    quarter-turn (or half-turn) so the sheet matches the screen.
    """
    baked = (float(rotation) - (int(page_rotation) % 360)) % 360
    if baked < 0.05 or baked > 359.95:
        return 0.0
    return baked


def _rgb(color: str) -> tuple[float, float, float]:
    return (
        int(color[1:3], 16) / 255,
        int(color[3:5], 16) / 255,
        int(color[5:7], 16) / 255,
    )


def _note_text(value) -> str:
    if not isinstance(value, str):
        raise ValueError("note text is missing")
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > 500:
        raise ValueError("note is too long")
    if any(ord(ch) < 32 and ch != "\n" for ch in text):
        raise ValueError("note has unsupported characters")
    lines = text.split("\n")
    if len(lines) > 16:
        raise ValueError("note has too many lines")
    if not any(line.strip() for line in lines):
        raise ValueError("note text is empty")
    return text


def _arrow_head(item: dict) -> tuple[float, float, float, float, float, float, float, float]:
    """Shaft end, tip, and the two wing points. The head sits on the second point."""
    x1, y1 = float(item["x1"]), float(item["y1"])
    x2, y2 = float(item["x2"]), float(item["y2"])
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    head = min(11.0, length * 0.45)
    wing = head * (4.2 / 11.0)
    bx, by = x2 - ux * head, y2 - uy * head
    return (bx, by, x2, y2, bx - uy * wing, by + ux * wing, bx + uy * wing, by - ux * wing)


HOP_RADIUS = 7.0


def _hoppable(item: dict) -> bool:
    kind = item.get("kind")
    if kind == "run":
        return True
    return kind == "line" and item.get("guide") is not True


def crossing_hops(items: list[dict]) -> dict[int, list[float]]:
    """Distances along the later segment where a dashed line or run should hop.

    The line or run that appears later in the list hops over the earlier one.
    Near-parallel lines and crossings at an endpoint are left alone.
    """
    indexes = [i for i, item in enumerate(items) if _hoppable(item)]
    found: dict[int, list[float]] = {i: [] for i in indexes}
    for pos, i in enumerate(indexes):
        first = items[i]
        ax1, ay1 = float(first["x1"]), float(first["y1"])
        ax2, ay2 = float(first["x2"]), float(first["y2"])
        arx, ary = ax2 - ax1, ay2 - ay1
        alen = math.hypot(arx, ary)
        if alen < 8:
            continue
        for j in indexes[pos + 1 :]:
            second = items[j]
            if int(first.get("page", -1)) != int(second.get("page", -2)):
                continue
            bx1, by1 = float(second["x1"]), float(second["y1"])
            bx2, by2 = float(second["x2"]), float(second["y2"])
            brx, bry = bx2 - bx1, by2 - by1
            blen = math.hypot(brx, bry)
            if blen < 8:
                continue
            den = arx * bry - ary * brx
            if abs(den) / (alen * blen) < 0.26:
                continue
            qpx, qpy = bx1 - ax1, by1 - ay1
            t = (qpx * bry - qpy * brx) / den
            u = (qpx * ary - qpy * arx) / den
            if 0.08 < t < 0.92 and 0.08 < u < 0.92:
                found[j].append(u * blen)
    return found


def _stroke_segment(page, x1, y1, x2, y2, distances, color, width, dashes, oc: int) -> None:
    """Straight stroke, with a semicircle hop at each crossing distance."""
    matrix = page.derotation_matrix
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1:
        return
    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    px, py = -uy, ux
    radius = min(HOP_RADIUS, length * 0.18)
    cuts: list[tuple[float, float]] = []
    for dist in sorted(float(item) for item in distances or []):
        if dist - radius < 6 or dist + radius > length - 6:
            continue
        if cuts and dist - radius < cuts[-1][1] + 1:
            continue
        cuts.append((dist - radius, dist + radius))

    def pt(x: float, y: float) -> pymupdf.Point:
        return pymupdf.Point(x, y) * matrix

    shaft = page.new_shape()
    arc = page.new_shape() if cuts else None
    cx, cy = x1, y1
    bow = 0.5522847498
    for start, stop in cuts:
        ax, ay = x1 + ux * start, y1 + uy * start
        bx, by = x1 + ux * stop, y1 + uy * stop
        mid = (start + stop) / 2
        topx = x1 + ux * mid + px * radius
        topy = y1 + uy * mid + py * radius
        shaft.draw_line(pt(cx, cy), pt(ax, ay))
        assert arc is not None
        arc.draw_bezier(
            pt(ax, ay),
            pt(ax + px * bow * radius, ay + py * bow * radius),
            pt(topx - ux * bow * radius, topy - uy * bow * radius),
            pt(topx, topy),
        )
        arc.draw_bezier(
            pt(topx, topy),
            pt(topx + ux * bow * radius, topy + uy * bow * radius),
            pt(bx + px * bow * radius, by + py * bow * radius),
            pt(bx, by),
        )
        cx, cy = bx, by
    shaft.draw_line(pt(cx, cy), pt(x2, y2))
    shaft.finish(color=color, width=width, dashes=dashes, closePath=False, lineCap=0, oc=oc)
    shaft.commit(overlay=True)
    if arc is not None:
        arc.finish(color=color, width=width, closePath=False, lineCap=1, oc=oc)
        arc.commit(overlay=True)


def _draw_line(page, item: dict, oc: int = 0, hops: list[float] | None = None) -> None:
    """Dashed switch leg, or a finer construction line. Endpoints are visual."""
    guide = item.get("guide") is True
    if guide:
        matrix = page.derotation_matrix
        page.draw_line(
            pymupdf.Point(item["x1"], item["y1"]) * matrix,
            pymupdf.Point(item["x2"], item["y2"]) * matrix,
            color=_rgb(item["color"]),
            width=0.9,
            dashes="[2.5 2.5] 0",
            lineCap=0,
            overlay=True,
            oc=oc,
        )
        return
    _stroke_segment(
        page,
        float(item["x1"]),
        float(item["y1"]),
        float(item["x2"]),
        float(item["y2"]),
        hops or [],
        _rgb(item["color"]),
        1.35,
        "[8 6] 0",
        oc,
    )


def _draw_arrow(page, item: dict, oc: int = 0) -> None:
    """Solid leader. The head is at the second point, in the visual direction."""
    matrix = page.derotation_matrix
    bx, by, x2, y2, lx, ly, rx, ry = _arrow_head(item)
    color = _rgb(item["color"])

    def pt(x: float, y: float) -> pymupdf.Point:
        return pymupdf.Point(x, y) * matrix

    page.draw_line(pt(item["x1"], item["y1"]), pt(bx, by), color=color, width=1.35, lineCap=0, overlay=True, oc=oc)
    page.draw_polyline(
        [pt(x2, y2), pt(lx, ly), pt(rx, ry)],
        color=color,
        fill=color,
        width=0.6,
        closePath=True,
        lineJoin=1,
        overlay=True,
        oc=oc,
    )


def _under_perp(ux: float, uy: float) -> tuple[float, float]:
    """Unit perpendicular that sits under a run, in visual y-down space."""
    px, py = -uy, ux
    if abs(ux) >= abs(uy):
        if py < 0:
            px, py = -px, -py
    elif px < 0:
        px, py = -px, -py
    return px, py


def _readable_angle(dx: float, dy: float) -> float:
    """Degrees of the run, flipped so the label is not upside down."""
    angle = math.degrees(math.atan2(dy, dx))
    if angle > 90 or angle <= -90:
        angle += 180
    return angle


def _draw_run(page, item: dict, label: str, oc: int = 0, hops: list[float] | None = None) -> None:
    """Solid run with end bars and a label centered on the under side."""
    matrix = page.derotation_matrix
    x1, y1 = float(item["x1"]), float(item["y1"])
    x2, y2 = float(item["x2"]), float(item["y2"])
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    px, py = _under_perp(ux, uy)
    color = _rgb(item["color"])
    bar = 5.5

    def pt(x: float, y: float) -> pymupdf.Point:
        return pymupdf.Point(x, y) * matrix

    _stroke_segment(page, x1, y1, x2, y2, hops or [], color, 1.35, None, oc)
    for sx, sy in ((x1, y1), (x2, y2)):
        page.draw_line(
            pt(sx - px * bar, sy - py * bar),
            pt(sx + px * bar, sy + py * bar),
            color=color,
            width=1.35,
            lineCap=0,
            overlay=True,
            oc=oc,
        )
    fontsize = 8.0
    width = pymupdf.get_text_length(label, fontname="hebo", fontsize=fontsize)
    if width > length * 0.92 and width > 0:
        fontsize = max(4.5, fontsize * (length * 0.92) / width)
        width = pymupdf.get_text_length(label, fontname="hebo", fontsize=fontsize)
    ascent = pymupdf.Font("hebo").ascender * fontsize
    gap = 2.4
    angle = _readable_angle(dx, dy)
    tang = math.radians(angle)
    tx, ty = math.cos(tang), math.sin(tang)
    bx = (x1 + x2) / 2 + px * (gap + ascent)
    by = (y1 + y2) / 2 + py * (gap + ascent)
    origin = pt(bx, by)
    dxp = matrix.a * tx + matrix.c * ty
    dyp = matrix.b * tx + matrix.d * ty
    # insert_text morph rotates in PDF y-up space, so the y-down angle is negated.
    pang = math.degrees(math.atan2(-dyp, dxp))
    page.insert_text(
        pymupdf.Point(origin.x - width / 2, origin.y),
        label,
        fontsize=fontsize,
        fontname="hebo",
        color=color,
        morph=(origin, pymupdf.Matrix(pang)),
        overlay=True,
        oc=oc,
    )


def _draw_note(page, item: dict, oc: int = 0) -> None:
    """Note block. x, y is the visual top-left. Text stays upright on the sheet."""
    size = float(item["size"])
    lines = item["text"].split("\n")
    widths = [pymupdf.get_text_length(line, fontname="helv", fontsize=size) for line in lines]
    text_w = max(widths) if widths else 0.0
    font = pymupdf.Font("helv")
    ascent = font.ascender * size
    descent = -font.descender * size
    leading = size * 1.25
    pad_x, pad_y = 3.0, 1.5
    x, y = float(item["x"]), float(item["y"])
    box_w = text_w + pad_x * 2
    box_h = pad_y * 2 + ascent + descent + leading * (len(lines) - 1)
    matrix = page.derotation_matrix

    def pt(px: float, py: float) -> pymupdf.Point:
        return pymupdf.Point(px, py) * matrix

    page.draw_polyline(
        [pt(x, y), pt(x + box_w, y), pt(x + box_w, y + box_h), pt(x, y + box_h)],
        color=(1, 1, 1),
        fill=(1, 1, 1),
        width=0.4,
        closePath=True,
        overlay=True,
        oc=oc,
    )
    color = _rgb(item["color"])
    rotate = int(page.rotation) % 360
    for index, line in enumerate(lines):
        if not line:
            continue
        baseline = pt(x + pad_x, y + pad_y + ascent + index * leading)
        page.insert_text(
            baseline,
            line,
            fontsize=size,
            fontname="helv",
            color=color,
            rotate=rotate,
            overlay=True,
            oc=oc,
        )


def _draw_whitebox(page, item: dict, oc: int = 0) -> None:
    """Opaque white rectangle in visual coordinates. It covers the sheet under it."""
    x1, y1 = float(item["x1"]), float(item["y1"])
    x2, y2 = float(item["x2"]), float(item["y2"])
    left, right = min(x1, x2), max(x1, x2)
    top, bottom = min(y1, y2), max(y1, y2)
    matrix = page.derotation_matrix

    def pt(px: float, py: float) -> pymupdf.Point:
        return pymupdf.Point(px, py) * matrix

    page.draw_polyline(
        [pt(left, top), pt(right, top), pt(right, bottom), pt(left, bottom)],
        color=(1, 1, 1),
        fill=(1, 1, 1),
        width=0.6,
        closePath=True,
        overlay=True,
        oc=oc,
    )


def _erase_under_whiteboxes(doc: pymupdf.Document, boxes: list[dict]) -> None:
    """Remove what is under each white box from the sheet itself.

    Painting white only hides the plan. The text, scanned pixels, and line
    work stay in the file, and anyone can select or uncover them. Redaction
    deletes text and image pixels under the box and any line work the box
    fully covers. A wall that only crosses the box is kept, so it does not
    vanish outside the box; the white paint still hides that part.
    """
    by_page: dict[int, list[dict]] = {}
    for item in boxes:
        by_page.setdefault(int(item["page"]), []).append(item)
    for index, items in by_page.items():
        page = doc[index]
        matrix = page.derotation_matrix
        for item in items:
            x1, y1 = float(item["x1"]), float(item["y1"])
            x2, y2 = float(item["x2"]), float(item["y2"])
            rect = pymupdf.Rect(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)) * matrix
            rect.normalize()
            page.add_redact_annot(rect, fill=(1, 1, 1))
        page.apply_redactions(
            images=pymupdf.PDF_REDACT_IMAGE_PIXELS,
            graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        )


def _draw_height_tag(page, x: float, y: float, size: float, text: str, oc: int = 0) -> None:
    """Height under an outlet. It stays upright when the outlet rotates."""
    label = str(text or "").strip()
    if not label:
        return
    font_size = max(7.0, min(12.0, float(size) * 0.34))
    width = pymupdf.get_text_length(label, fontname="hebo", fontsize=font_size)
    font = pymupdf.Font("hebo")
    ascent = font.ascender * font_size
    descent = -font.descender * font_size
    left = x - width / 2 - 1.5
    top = y + size / 2 + 1.5
    box_w = width + 3.0
    box_h = ascent + descent + 1.2
    matrix = page.derotation_matrix

    def pt(px: float, py: float) -> pymupdf.Point:
        return pymupdf.Point(px, py) * matrix

    page.draw_polyline(
        [pt(left, top), pt(left + box_w, top), pt(left + box_w, top + box_h), pt(left, top + box_h)],
        color=(1, 1, 1),
        fill=(1, 1, 1),
        width=0.3,
        closePath=True,
        overlay=True,
        oc=oc,
    )
    page.insert_text(
        pt(left + 1.5, top + ascent + 0.4),
        label,
        fontsize=font_size,
        fontname="hebo",
        color=(0.08, 0.08, 0.08),
        rotate=int(page.rotation) % 360,
        overlay=True,
        oc=oc,
    )


def _draw_circuit_tag(page, x: float, y: float, text: str, oc: int = 0) -> None:
    """Tiny circuit id. x, y is the visual baseline."""
    label = str(text or "").strip()
    if not label:
        return
    baseline = pymupdf.Point(x, y) * page.derotation_matrix
    page.insert_text(
        baseline,
        label,
        fontsize=7,
        fontname="helv",
        color=(0.08, 0.08, 0.08),
        rotate=int(page.rotation) % 360,
        overlay=True,
        oc=oc,
    )


def _stamp_legend(page, item: dict, src: pymupdf.Document, nat_w: float, nat_h: float, oc: int = 0) -> None:
    width = float(item["width"])
    height = nat_h * width / nat_w
    rect = pymupdf.Rect(item["x"], item["y"], item["x"] + width, item["y"] + height)
    rect = rect * page.derotation_matrix
    # The block is upright. This turn puts that upright edge on the page as
    # shown, so a viewer’s /Rotate does not lay the legend on its side.
    page.show_pdf_page(
        rect,
        src,
        0,
        overlay=True,
        keep_proportion=True,
        rotate=int(page.rotation) % 360,
        oc=oc,
    )


def _legend_symbols(symbols_by_id: dict, placements: list[dict], hidden: set[str]) -> list[dict]:
    """Symbols placed on a visible layer, in catalog order.

    A hidden layer stays off the key. One placement is enough, including a run.
    An outlet height gets its own row. Notes, arrows, dashed lines, legends,
    and white boxes are not symbols.
    """
    used: dict[str, set[str]] = {}
    for item in placements:
        kind = item.get("kind") or "symbol"
        if kind not in ("symbol", "run"):
            continue
        sid = item.get("symbolId")
        if not sid or sid not in symbols_by_id:
            continue
        if (item.get("layer") or "Power") in hidden:
            continue
        height = ""
        sym = symbols_by_id[sid]
        if sym.get("category") == "receptacles" and item.get("height"):
            height = str(item["height"])
        used.setdefault(sid, set()).add(height)
    entries = []
    for sid, sym in symbols_by_id.items():
        if sid not in used:
            continue
        for height in sorted(used[sid], key=_height_rank):
            if height:
                entries.append({**sym, "name": f"{sym['name']} {height}"})
            else:
                entries.append(sym)
    return entries


def export_pdf(
    pdf_bytes: bytes,
    placements: list[dict],
    symbols_by_id: dict,
    *,
    ocg: bool = False,
    hidden_layers: list[str] | None = None,
    show_circuits: bool = False,
    revise: bool = False,
    project: dict | None = None,
) -> bytes:
    """Return a new PDF with each placement drawn on top of the original page.

    Coordinates are visual: origin at the top-left of the page as shown,
    y downward, units in PDF points. Page rotation (/Rotate) is honored.
    A placement is a symbol unless kind is "line", "arrow", "note", "run",
    "legend", or "whitebox". White rectangles are drawn first, so they cover
    the original sheet and the symbols stay on top. A flat final export also
    erases the text and image pixels under them. Export all layers paints the
    box into its group instead, so turning that group off shows the plan again.
    The source bytes are not modified. When ocg is set, each layer is an
    optional content group.
    A revision file also carries the unmarked PDF and the marks, so Plan Marks
    can open it and keep the marks editable.
    """
    hidden = set(hidden_layers or [])
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    cache: dict[tuple, pymupdf.Document] = {}
    legend_doc: pymupdf.Document | None = None
    legend_size: tuple[float, float] | None = None
    groups: dict[str, int] = {}
    try:
        if ocg:
            names: list[str] = []
            for item in placements:
                name = item.get("layer") or "Power"
                if name not in names:
                    names.append(name)
            for name in names:
                groups[name] = doc.add_ocg(name, on=name not in hidden)
            if groups:
                doc.set_layer(
                    -1,
                    on=[xref for name, xref in groups.items() if name not in hidden] or None,
                    off=[xref for name, xref in groups.items() if name in hidden] or None,
                )

        def oc_for(item: dict) -> int:
            if not groups:
                return 0
            return groups.get(item.get("layer") or "Power", 0)

        # Hidden layers stay out unless every layer is written as an optional group.
        drawing = placements
        if hidden and not ocg:
            drawing = [item for item in placements if (item.get("layer") or "Power") not in hidden]
        # White boxes cover the underlay. Everything else is drawn after them.
        ordered = [item for item in drawing if item.get("kind") == "whitebox"]
        ordered.extend(item for item in drawing if item.get("kind") != "whitebox")
        if not revise and not ocg:
            # A flat final export goes out to other people, so a white box erases.
            # Hidden boxes are already left out of this list.
            # Export all layers keeps the bytes, and the white paint lives in the group.
            erase = [item for item in ordered if item.get("kind") == "whitebox"]
            _erase_under_whiteboxes(doc, erase)
        hop_map = crossing_hops(ordered)
        for index, item in enumerate(ordered):
            page = doc[item["page"]]
            kind = item.get("kind") or "symbol"
            oc = oc_for(item)
            if kind == "whitebox":
                _draw_whitebox(page, item, oc)
                continue
            if kind == "line":
                _draw_line(page, item, oc, hop_map.get(index))
                if show_circuits and item.get("circuit") and item.get("guide") is not True:
                    _draw_circuit_tag(
                        page,
                        (item["x1"] + item["x2"]) / 2,
                        min(item["y1"], item["y2"]) - 3,
                        item["circuit"],
                        oc,
                    )
                continue
            if kind == "arrow":
                _draw_arrow(page, item, oc)
                continue
            if kind == "note":
                _draw_note(page, item, oc)
                continue
            if kind == "run":
                label = str(symbols_by_id[item["symbolId"]].get("runLabel") or "").strip()
                if not label:
                    raise ValueError("run has no label")
                _draw_run(page, item, label, oc, hop_map.get(index))
                if show_circuits and item.get("circuit"):
                    _draw_circuit_tag(
                        page,
                        (item["x1"] + item["x2"]) / 2,
                        min(item["y1"], item["y2"]) - 3,
                        item["circuit"],
                        oc,
                    )
                continue
            if kind == "legend":
                if legend_doc is None:
                    from elecplan.legend import build_legend_block

                    raw, nat_w, nat_h = build_legend_block(_legend_symbols(symbols_by_id, placements, hidden))
                    legend_doc = pymupdf.open(stream=raw, filetype="pdf")
                    legend_size = (nat_w, nat_h)
                assert legend_size is not None
                _stamp_legend(page, item, legend_doc, legend_size[0], legend_size[1], oc)
                continue
            baked = _baked_rotation(item["rotation"], page.rotation)
            key = (item["symbolId"], round(baked, 1), item["color"])
            src = cache.get(key)
            if src is None:
                svg = prepare_svg(
                    symbols_by_id[item["symbolId"]]["svg"],
                    baked,
                    item["color"],
                )
                src = _svg_to_pdf(svg)
                cache[key] = src
            size = item["size"]
            x = item["x"]
            y = item["y"]
            rect = pymupdf.Rect(x - size / 2, y - size / 2, x + size / 2, y + size / 2)
            # show_pdf_page uses the unrotated page space. derotation_matrix
            # maps a rectangle in the on-screen view back to that space.
            # The spin itself was baked with the page rotation removed.
            rect = rect * page.derotation_matrix
            page.show_pdf_page(rect, src, 0, overlay=True, keep_proportion=True, oc=oc)
            sym = symbols_by_id[item["symbolId"]]
            if item.get("height") and sym.get("category") == "receptacles":
                _draw_height_tag(page, x, y, size, item["height"], oc)
            if show_circuits and item.get("circuit"):
                _draw_circuit_tag(page, x + size / 2 + 2, y - size / 2 + 7, item["circuit"], oc)
        if revise:
            if not isinstance(project, dict):
                raise ValueError("A revision export needs the marks")
            doc.embfile_add(
                REVISE_MARKS,
                json.dumps(project, ensure_ascii=False).encode("utf-8"),
                filename=REVISE_MARKS,
                desc="Plan Marks marks",
            )
            doc.embfile_add(
                REVISE_SOURCE,
                pdf_bytes,
                filename=REVISE_SOURCE,
                desc="Unmarked plan",
            )
        return doc.tobytes(deflate=True, garbage=3)
    finally:
        for src in cache.values():
            src.close()
        if legend_doc is not None:
            legend_doc.close()
        doc.close()
