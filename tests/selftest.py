"""API, placement, and export checks for Plan Marks. No network beyond localhost."""

from __future__ import annotations

import json
import re
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Recovery files and kept sheets go to a scratch folder, not the real one.
os.environ["PLANMARKS_RECOVERY_DIR"] = tempfile.mkdtemp(prefix="planmarks-test-")

import pymupdf

from elecplan.counts import build_counts_pdf
from elecplan.export import crossing_hops, export_pdf, parse_placements
from elecplan.legend import build_legend_block, build_legend_pdf, choose_legend_symbols, legend_layout
from elecplan.library import load_symbols, prepare_svg
from elecplan.sample_plan import build_sample_pdf
from elecplan.server import App, Session, make_server, prune_recovery, recovery_dir, request_allowed

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def request(base, path, data=None, headers=None, method=None):
    req = urllib.request.Request(base + path, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            body = res.read()
            return res.status, dict(res.headers), body
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def dark_pixels(pix, x0, y0, x1, y1):
    x0, x1 = int(max(0, min(x0, x1))), int(min(pix.width, max(x0, x1)))
    y0, y1 = int(max(0, min(y0, y1))), int(min(pix.height, max(y0, y1)))
    count = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            px = pix.pixel(x, y)
            if px[0] < 200 or px[1] < 200 or px[2] < 200:
                count += 1
    return count


def pixmap_diff(a, ax, ay, b, bx, by, pad):
    """Mean channel difference of two square crops. 0 is the same picture."""
    total = 0
    count = 0
    for y in range(-pad, pad):
        for x in range(-pad, pad):
            pa = a.pixel(int(ax + x), int(ay + y))
            pb = b.pixel(int(bx + x), int(by + y))
            total += abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) + abs(pa[2] - pb[2])
            count += 3
    return total / count


def curve_count(pdf_bytes):
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    count = 0
    try:
        for item in doc[0].get_drawings():
            for part in item["items"]:
                if part[0] == "c":
                    count += 1
    finally:
        doc.close()
    return count


def text_dirs(page, needle):
    found = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line.get("spans", []))
            if needle in text:
                found.append((text, line.get("dir")))
    return found


def grab_function(src, name):
    start = src.find(f"function {name}(")
    if start < 0:
        raise AssertionError(name)
    brace = src.find("{", start)
    depth = 0
    for index in range(brace, len(src)):
        if src[index] == "{":
            depth += 1
        elif src[index] == "}":
            depth -= 1
            if depth == 0:
                return src[start : index + 1]
    raise AssertionError(name)


def check_wall_side():
    marks = (ROOT / "elecplan/static/marks.js").read_text()
    tools = (ROOT / "elecplan/static/tools.js").read_text()
    core = (ROOT / "elecplan/static/core.js").read_text()
    script = (
        grab_function(core, "normRot")
        + "\n"
        + grab_function(marks, "sitsBesideWall")
        + "\n"
        + grab_function(tools, "wallSidePoint")
        + "\n"
        + grab_function(tools, "wallRotation")
        + """
function near(a, b) { return Math.abs(a - b) < 0.001; }
const below = wallSidePoint({x: 10, y: 20, nx: 0, ny: 1}, 12);
if (!near(below.x, 10) || !near(below.y, 32)) process.exit(1);
const above = wallSidePoint({x: 10, y: 20, nx: 0, ny: -1}, 12);
if (!near(above.x, 10) || !near(above.y, 8)) process.exit(1);
if (!sitsBesideWall({category: "switches", wall: true})) process.exit(2);
if (!sitsBesideWall({category: "receptacles", wall: true})) process.exit(3);
if (sitsBesideWall({category: "receptacles", wall: false})) process.exit(4);
if (sitsBesideWall({category: "lighting", wall: true})) process.exit(5);
if (sitsBesideWall({category: "lighting", wall: false})) process.exit(6);
if (wallRotation(0, 1) !== 0) process.exit(7);
if (wallRotation(1, 0) !== -90) process.exit(8);
if (wallRotation(-1, 0) !== 90) process.exit(9);
if (wallRotation(0, -1) !== 0) process.exit(10);
if (wallRotation(0, 1, true) !== 90) process.exit(11);
if (wallRotation(1, 0, true) !== 0) process.exit(12);
if (wallRotation(-1, 0, true) !== 180) process.exit(13);
if (wallRotation(0, -1, true) !== 270) process.exit(14);
"""
    )
    run = subprocess.run(["node", "-e", script], capture_output=True, text=True)
    check(
        "outlet snap sits beside the wall",
        run.returncode == 0,
        (run.stderr or run.stdout)[-300:],
    )


def main():
    check_wall_side()
    print("library")
    lib = load_symbols()
    ids = {item["id"] for item in lib["symbols"]}
    needed = {"duplex", "gfci", "switch", "switch3", "ceiling", "sconce", "smoke", "panel"}
    check("core symbols", needed <= ids, sorted(needed - ids))
    check("at least 12 symbols", len(lib["symbols"]) >= 12, str(len(lib["symbols"])))
    added = {
        "single",
        "usb",
        "ev",
        "outlet30",
        "outlet50",
        "coax",
        "cat6",
        "coaxcat6",
        "smurf",
        "chime",
        "meter",
    }
    check("new symbols", added <= ids, sorted(added - ids))
    gfci = next(item for item in lib["symbols"] if item["id"] == "gfci")
    check("gfi is an outlet", "<circle" in gfci["svg"] and ">GFI<" in gfci["svg"])
    dimmer = next(item for item in lib["symbols"] if item["id"] == "dimmer")
    check("dimmer is a switch marked D", ">SD<" in dimmer["svg"])
    timer = next(item for item in lib["symbols"] if item["id"] == "timer")
    ac = next(item for item in lib["symbols"] if item["id"] == "ac")
    check("timer switch is ST", ">ST<" in timer["svg"] and "<circle" not in timer["svg"])
    check("a/c is a labeled box", "<rect" in ac["svg"] and ">A/C<" in ac["svg"])
    panel = next(item for item in lib["symbols"] if item["id"] == "panel")
    check("panel is a labeled box", "<rect" in panel["svg"] and ">PANEL<" in panel["svg"])
    check("lighting additions", {"pendant", "exhaust"} <= ids)
    check("letter-only under cabinet mark is gone", "ucl" not in ids)
    pendant = next(item for item in lib["symbols"] if item["id"] == "pendant")
    exhaust = next(item for item in lib["symbols"] if item["id"] == "exhaust")
    fan = next(item for item in lib["symbols"] if item["id"] == "fan")
    ucl120 = next(item for item in lib["symbols"] if item["id"] == "ucl120")
    tape = next(item for item in lib["symbols"] if item["id"] == "ledtape")
    check("120V run is its own symbol", ucl120["place"] == "run" and ucl120["runLabel"] == "120V" and ">120V<" in ucl120["svg"])
    check("tape run is its own symbol", tape["place"] == "run" and tape["runLabel"] == "TAPE" and ">TAPE<" in tape["svg"])
    check("pendant hangs", "<circle" in pendant["svg"] and "<line" in pendant["svg"])
    check("bath fan is EF", ">EF<" in exhaust["svg"] and "<circle" in exhaust["svg"])
    check("bath fan is not the ceiling fan", "ellipse" in fan["svg"] and "ellipse" not in exhaust["svg"])
    floor = next(item for item in lib["symbols"] if item["id"] == "floor")
    flood = next(item for item in lib["symbols"] if item["id"] == "flood")
    eave = next(item for item in lib["symbols"] if item["id"] == "eave")
    ev = next(item for item in lib["symbols"] if item["id"] == "ev")
    heater = next(item for item in lib["symbols"] if item["id"] == "heater")
    floorheat = next(item for item in lib["symbols"] if item["id"] == "floorheat")
    check("floor plug is a square outlet", "<rect" in floor["svg"] and "<line" in floor["svg"] and floor["wall"] is False)
    check("flood light throws a beam", "<path" in flood["svg"] and "<circle" in flood["svg"])
    check(
        "eave plug is a roof over an outlet",
        "<path" in eave["svg"] and "<circle" in eave["svg"] and ">E<" not in eave["svg"] and ">EV<" not in eave["svg"],
    )
    check("eave plug is not the ev outlet", eave["svg"] != ev["svg"] and ">EV<" in ev["svg"])
    check("patio heater is a labeled box", ">PH<" in heater["svg"] and "<rect" in heater["svg"])
    check("floor heat is a labeled box", ">FH<" in floorheat["svg"] and "<rect" in floorheat["svg"])
    generator = next(item for item in lib["symbols"] if item["id"] == "generator")
    check("generator is a labeled box", ">GEN<" in generator["svg"] and "<rect" in generator["svg"] and generator["place"] == "point")
    fresh = {
        "steplight": ("lighting", True),
        "artlight": ("lighting", True),
        "chandelier": ("lighting", False),
        "shoplight": ("lighting", False),
        "vanitybar": ("lighting", True),
        "recessed4": ("lighting", False),
        "recessed6": ("lighting", False),
        "occ": ("switches", True),
        "motion": ("switches", True),
        "fanspeed": ("switches", True),
        "fanlight": ("switches", True),
        "photocell": ("switches", True),
        "humidity": ("switches", True),
        "wifi": ("switches", True),
        "duplex20": ("receptacles", True),
        "gfci20": ("receptacles", True),
        "halfhot": ("receptacles", True),
        "clock": ("receptacles", True),
        "popup": ("receptacles", False),
        "inlet30": ("receptacles", True),
        "inlet50": ("receptacles", True),
        "hood": ("equipment", True),
        "disposal": ("equipment", False),
        "waterheater": ("equipment", False),
        "furnace": ("equipment", False),
        "camera": ("lowvoltage", False),
        "mediapanel": ("lowvoltage", True),
        "wap": ("lowvoltage", False),
        "subpanel": ("equipment", True),
        "xfer": ("equipment", True),
        "sump": ("equipment", False),
        "wellpump": ("equipment", False),
        "septic": ("equipment", False),
        "evse": ("equipment", True),
        "mts": ("equipment", True),
        "ats": ("equipment", True),
        "loadcenter": ("equipment", True),
        "jbox": ("equipment", True),
        "gate": ("equipment", False),
    }
    by = {item["id"]: item for item in lib["symbols"]}
    check("added plan symbols", set(fresh) <= ids, sorted(set(fresh) - ids))
    misplaced = [
        sid
        for sid, (category, wall) in fresh.items()
        if by[sid]["category"] != category or by[sid]["wall"] is not wall or by[sid]["place"] != "point"
    ]
    check("added symbols keep their group", not misplaced, str(misplaced))
    check("occupancy switch is OCC", ">OCC<" in by["occ"]["svg"] and "<circle" not in by["occ"]["svg"])
    check("20A duplex is labeled", ">20A<" in by["duplex20"]["svg"] and "<circle" in by["duplex20"]["svg"])
    check("48 inch outlet is not its own symbol", "outlet48" not in ids)
    gear = {"oven", "cooktop", "dishwasher", "microwave", "refrigerator", "washer", "dryer", "heat", "disconnect", "smokeco", "tv"}
    check("appliance and detector symbols", gear <= ids, sorted(gear - ids))
    export_src = (ROOT / "elecplan/export.py").read_text(encoding="utf-8")
    check("export removes duplicate fonts", "tobytes(deflate=True, garbage=4)" in export_src)
    check("20A gfi is its own outlet", ">20A GFI<" in by["gfci20"]["svg"] and by["gfci20"]["svg"] != gfci["svg"])
    check("cans keep their sizes", '>4"<' in by["recessed4"]["svg"] and '>6"<' in by["recessed6"]["svg"])
    check("camera is low voltage", by["camera"]["defaultColor"] == "#1d4e89" and "<rect" in by["camera"]["svg"])
    check(
        "inlet is not the 30A outlet",
        ">IN 30A<" in by["inlet30"]["svg"]
        and ">30A 240V<" not in by["inlet30"]["svg"]
        and by["inlet30"]["svg"] != next(item["svg"] for item in lib["symbols"] if item["id"] == "outlet30"),
    )
    check("hardwired charger is its own mark", ">EVSE<" in by["evse"]["svg"] and by["evse"]["svg"] != ev["svg"])
    check("load center is its own mark", ">LC<" in by["loadcenter"]["svg"] and ">PANEL<" not in by["loadcenter"]["svg"])
    check("well pump is marked WELL", ">WELL<" in by["wellpump"]["svg"] and ">WP<" not in by["wellpump"]["svg"])
    for sid in ("camera", "mediapanel", "wap"):
        check(f"{sid} ink can recolor", by[sid]["defaultColor"] == "#1d4e89" and "#141414" in by[sid]["svg"])
    layout = legend_layout(lib["symbols"])
    check(
        "legend layout keeps every symbol it is given",
        {entry["id"] for entry in layout["items"]} == ids and layout["width"] > 200,
    )
    chosen = choose_legend_symbols(lib["symbols"], ["pendant", "nope", "duplex"])
    check("legend keeps catalog order", [item["id"] for item in chosen] == ["duplex", "pendant"])
    named = choose_legend_symbols(
        lib["symbols"],
        ["duplex", "duplex", "nope"],
        ["Duplex outlet 48\"", "Duplex outlet", "Ignored"],
    )
    check(
        "legend lists each outlet height",
        [item["name"] for item in named] == ["Duplex outlet 48\"", "Duplex outlet"],
    )
    named_amps = choose_legend_symbols(
        lib["symbols"],
        ["furnace", "furnace", "ac"],
        ["Furnace 30A", "Furnace", "A/C 40A 240V"],
    )
    check(
        "legend lists each equipment ampacity",
        [item["name"] for item in named_amps] == ["Furnace 30A", "Furnace", "A/C 40A 240V"],
    )
    named_switch = choose_legend_symbols(lib["symbols"], ["switch"], ['Single-pole switch 48"'])
    check(
        "legend lists a switch height",
        [item["name"] for item in named_switch] == ['Single-pole switch 48"'],
    )
    try:
        choose_legend_symbols(lib["symbols"], [])
        check("empty legend is refused", False)
    except ValueError as exc:
        check("empty legend is refused", "no symbols" in str(exc).lower(), str(exc))
    for item in lib["symbols"]:
        check(f"svg {item['id']}", "viewBox" in item["svg"] and 'class="rot"' in item["svg"])

    rotated = prepare_svg(lib["symbols"][0]["svg"], 90, "#c4271b")
    check("rotation baked", "rotate(90.00 50 50)" in rotated)
    check("color baked", "#c4271b" in rotated and "#141414" not in rotated)
    upright = prepare_svg(next(s["svg"] for s in lib["symbols"] if s["id"] == "switch3"), 90, "#141414")
    check(
        "rotation wraps the symbol",
        'class="spin"' in upright and upright.index('class="label"') > upright.index("rotate(90.00 50 50)"),
    )

    extra = Path("/tmp/planmarks-extra-symbols")
    if extra.exists():
        for child in extra.iterdir():
            child.unlink()
    else:
        extra.mkdir()
    (extra / "catalog.json").write_text(
        json.dumps(
            {
                "categories": [{"id": "receptacles", "name": "Receptacles"}],
                "symbols": [
                    {
                        "id": "duplex",
                        "name": "Duplex outlet",
                        "category": "receptacles",
                        "file": "duplex.svg",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (extra / "duplex.svg").write_text(
        (ROOT / "symbols" / "duplex.svg").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (extra / "custom_mark.svg").write_text(
        """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g class="rot" fill="none" stroke="#141414" stroke-width="4">
    <circle cx="50" cy="50" r="20"/>
  </g>
</svg>""",
        encoding="utf-8",
    )
    extra_lib = load_symbols(extra)
    check(
        "dropped-in symbol",
        any(item["id"] == "custom_mark" and item["category"] == "custom" for item in extra_lib["symbols"]),
    )

    print("sample plan")
    sample = build_sample_pdf()
    sample_doc = pymupdf.open(stream=sample, filetype="pdf")
    check("sample has 2 sheets", sample_doc.page_count == 2)
    sample_text = sample_doc[0].get_text()
    check("sample has living room", "LIVING" in sample_text, sample_text[:200])
    check("sample names the 10 ft dimension", "10'-0\"" in sample_text)
    sample_doc[0].get_pixmap(dpi=80, alpha=False).save("/tmp/planmarks-sample.png")
    sample_doc.close()

    print("stamp")
    by_id = {item["id"]: item for item in lib["symbols"]}
    # Blank page. Duplex bars run across the circle and turn with the symbol.
    # A switch is the letter only: no framing circle and no leader.
    blank = pymupdf.open()
    blank.new_page(width=300, height=300)
    blank_bytes = blank.tobytes()
    blank.close()

    def placed(symbol, rotation):
        return export_pdf(
            blank_bytes,
            [
                {
                    "symbolId": symbol,
                    "page": 0,
                    "x": 150,
                    "y": 150,
                    "size": 100,
                    "rotation": rotation,
                    "color": "#141414",
                }
            ],
            by_id,
        )

    flat_doc = pymupdf.open(stream=placed("duplex", 0), filetype="pdf")
    flat_pix = flat_doc[0].get_pixmap(dpi=72, alpha=False)
    # Upper bar is viewBox y=44, x=32..68 → page y=144, x=132..168.
    across = dark_pixels(flat_pix, 132, 141, 140, 147)
    slot = dark_pixels(flat_pix, 141, 132, 147, 140)
    below = dark_pixels(flat_pix, 144, 186, 156, 198)
    check("duplex bars run across", across > 8, f"across={across}")
    check("duplex bars are not vertical", slot < 8, f"slot={slot}")
    check("no line below the duplex", below < 8, f"below={below}")
    flat_doc.close()

    spun_doc = pymupdf.open(stream=placed("duplex", 90), filetype="pdf")
    spun_pix = spun_doc[0].get_pixmap(dpi=72, alpha=False)
    across90 = dark_pixels(spun_pix, 132, 141, 140, 147)
    slot90 = dark_pixels(spun_pix, 141, 132, 147, 140)
    below90 = dark_pixels(spun_pix, 144, 186, 156, 198)
    check("duplex bars turn vertical", slot90 > 8, f"slot={slot90}")
    check("turned bars leave the old bar", across90 < 8, f"across={across90}")
    check("no line below a turned duplex", below90 < 8, f"below={below90}")
    spun_doc.close()

    letter_doc = pymupdf.open(stream=placed("switch", 90), filetype="pdf")
    letter_pix = letter_doc[0].get_pixmap(dpi=72, alpha=False)
    # Diagonals of a framing circle (r≈30). The letter sits inside that ring.
    ring = (
        dark_pixels(letter_pix, 166, 166, 176, 176)
        + dark_pixels(letter_pix, 124, 166, 134, 176)
        + dark_pixels(letter_pix, 166, 124, 176, 134)
        + dark_pixels(letter_pix, 124, 124, 134, 134)
    )
    check("switch has no framing circle", ring < 8, f"ring={ring}")
    dirs = text_dirs(letter_doc[0], "S")
    check("switch letter turns", bool(dirs) and abs(dirs[0][1][0]) < 0.2, str(dirs))
    letter_doc.close()

    # Page stored with /Rotate 90. Symbol at the visual center must land there.
    wide = pymupdf.open()
    page = wide.new_page(width=400, height=200)
    page.insert_text((170, 100), "HELLO", fontsize=18, fontname="helv")
    wide_bytes = wide.tobytes()
    wide.close()
    rotated_src = pymupdf.open(stream=wide_bytes, filetype="pdf")
    rotated_src[0].set_rotation(90)
    rotated_bytes = rotated_src.tobytes()
    visual = rotated_src[0].rect
    rotated_src.close()
    stamped = export_pdf(
        rotated_bytes,
        [
            {
                "symbolId": "switch3",
                "page": 0,
                "x": visual.width / 2,
                "y": visual.height / 2,
                "size": 60,
                "rotation": 0,
                "color": "#c4271b",
            }
        ],
        by_id,
    )
    stamped_doc = pymupdf.open(stream=stamped, filetype="pdf")
    stamped_pix = stamped_doc[0].get_pixmap(dpi=72, alpha=False)
    cx, cy = stamped_pix.width / 2, stamped_pix.height / 2
    center_ink = dark_pixels(stamped_pix, cx - 20, cy - 20, cx + 20, cy + 20)
    corner_ink = dark_pixels(stamped_pix, 0, 0, 18, 18)
    check("rotated sheet: symbol at visual center", center_ink > 15, f"center={center_ink}")
    check("rotated sheet: corner stays blank", corner_ink == 0, f"corner={corner_ink}")
    check("original text survives stamping", "HELLO" in stamped_doc[0].get_text())
    stamped_doc.close()

    # The spin is what was on screen. A sheet stored with /Rotate must not
    # turn the symbol again when a viewer honors that flag.
    plain = pymupdf.open()
    plain.new_page(width=200, height=200)
    plain_bytes = plain.tobytes()
    plain.close()

    def spun_sheet(page_rot):
        src = pymupdf.open()
        src.new_page(width=360, height=240)
        if page_rot:
            src[0].set_rotation(page_rot)
        raw = src.tobytes()
        rect = pymupdf.Rect(src[0].rect)
        src.close()
        return raw, rect

    def one_symbol(pdf, symbol, rotation, x, y):
        data = export_pdf(
            pdf,
            [
                {
                    "symbolId": symbol,
                    "page": 0,
                    "x": x,
                    "y": y,
                    "size": 64,
                    "rotation": rotation,
                    "color": "#141414",
                }
            ],
            by_id,
        )
        doc = pymupdf.open(stream=data, filetype="pdf")
        pix = doc[0].get_pixmap(dpi=72, alpha=False)
        doc.close()
        return pix

    screen = {angle: one_symbol(plain_bytes, "panel", angle, 100, 100) for angle in (0, 20, 90)}
    for page_rot in (0, 90, 180, 270):
        raw, rect = spun_sheet(page_rot)
        cx, cy = rect.width / 2, rect.height / 2
        for angle in (0, 20, 90):
            pix = one_symbol(raw, "panel", angle, cx, cy)
            same = pixmap_diff(pix, cx, cy, screen[angle], 100, 100, 30)
            other_angle = 0 if angle == 90 else 90
            other = pixmap_diff(pix, cx, cy, screen[other_angle], 100, 100, 30)
            check(
                f"sheet /Rotate {page_rot}: panel at {angle}° matches the screen",
                same < 2.5 and same + 2 < other,
                f"same={same:.2f} other={other:.2f}",
            )

    # Two sheets in one export, different /Rotate. They must not share a stamp.
    mixed = pymupdf.open()
    mixed.new_page(width=200, height=200)
    mixed.new_page(width=360, height=240)
    mixed[1].set_rotation(270)
    mixed_bytes = mixed.tobytes()
    mixed_rect = pymupdf.Rect(mixed[1].rect)
    mixed.close()
    mixed_pdf = export_pdf(
        mixed_bytes,
        [
            {"symbolId": "panel", "page": 0, "x": 100, "y": 100, "size": 64, "rotation": 0, "color": "#141414"},
            {
                "symbolId": "panel",
                "page": 1,
                "x": mixed_rect.width / 2,
                "y": mixed_rect.height / 2,
                "size": 64,
                "rotation": 90,
                "color": "#141414",
            },
        ],
        by_id,
    )
    mixed_doc = pymupdf.open(stream=mixed_pdf, filetype="pdf")
    mixed_flat = mixed_doc[0].get_pixmap(dpi=72, alpha=False)
    mixed_turned = mixed_doc[1].get_pixmap(dpi=72, alpha=False)
    flat_diff = pixmap_diff(mixed_flat, 100, 100, screen[0], 100, 100, 30)
    turned_diff = pixmap_diff(
        mixed_turned, mixed_rect.width / 2, mixed_rect.height / 2, screen[90], 100, 100, 30
    )
    check("mixed sheets: upright panel stays upright", flat_diff < 2.5, f"diff={flat_diff:.2f}")
    check(
        "mixed sheets: spun panel keeps its spin",
        turned_diff < 2.5,
        f"diff={turned_diff:.2f}",
    )
    mixed_doc.close()

    # Dashed switch leg, including on a rotated sheet, plus a legend block.
    def dash_runs(pix, x0, x1, y, dark_at=180):
        runs = []
        current = None
        length = 0
        y = int(y)
        for x in range(int(x0), int(x1)):
            px = pix.pixel(x, y)
            dark = px[0] < dark_at
            if dark != current:
                if current is not None:
                    runs.append((current, length))
                current = dark
                length = 1
            else:
                length += 1
        if current is not None:
            runs.append((current, length))
        return runs

    line_doc = pymupdf.open()
    line_doc.new_page(width=320, height=180)
    line_bytes = line_doc.tobytes()
    line_doc.close()
    parsed = parse_placements(
        [
            {"kind": "line", "page": 0, "x1": 30, "y1": 40, "x2": 290, "y2": 40, "color": "#141414"},
            {"symbolId": "exhaust", "page": 0, "x": 60, "y": 110, "size": 50, "rotation": 0, "color": "#141414"},
        ],
        1,
        ids,
    )
    lined = export_pdf(line_bytes, parsed, by_id)
    lined_doc = pymupdf.open(stream=lined, filetype="pdf")
    lined_pix = lined_doc[0].get_pixmap(dpi=72, alpha=False)
    runs = dash_runs(lined_pix, 50, 270, 40)
    dark_runs = [length for dark, length in runs if dark and length >= 3]
    light_runs = [length for dark, length in runs if not dark and length >= 3]
    check("dashed line has gaps", len(dark_runs) >= 2 and len(light_runs) >= 2, str(runs[:8]))
    check("dashed line stays on its path", dark_pixels(lined_pix, 40, 70, 80, 90) == 0)
    check("line page still stamps the bath fan", "EF" in lined_doc[0].get_text())
    lined_doc.close()

    guide_parsed = parse_placements(
        [
            {"kind": "line", "page": 0, "x1": 30, "y1": 20, "x2": 290, "y2": 20, "color": "#141414", "guide": True},
            {"kind": "line", "page": 0, "x1": 30, "y1": 70, "x2": 290, "y2": 70, "color": "#141414"},
        ],
        1,
        ids,
    )
    check(
        "construction line keeps the guide flag",
        guide_parsed[0]["guide"] is True and guide_parsed[1]["guide"] is False,
    )
    guided = export_pdf(line_bytes, guide_parsed, by_id)
    guided_doc = pymupdf.open(stream=guided, filetype="pdf")
    guided_pix = guided_doc[0].get_pixmap(dpi=72, alpha=False)

    def dash_count(pix, y0, y1):
        best = []
        for y in range(y0, y1 + 1):
            found = [length for dark, length in dash_runs(pix, 40, 280, y) if dark and 1 <= length <= 12]
            if len(found) > len(best):
                best = found
        return best

    guide_runs = dash_count(guided_pix, 16, 24)
    leg_runs = dash_count(guided_pix, 66, 74)
    check(
        "construction line is a finer dash",
        len(guide_runs) > len(leg_runs) >= 2,
        f"guide={len(guide_runs)} leg={len(leg_runs)}",
    )
    guided_doc.close()

    leg_page = pymupdf.open()
    leg_page.new_page(width=720, height=560)
    leg_bytes = leg_page.tobytes()
    leg_page.close()
    leg_pdf = export_pdf(
        leg_bytes,
        [
            {"symbolId": "floor", "page": 0, "x": 40, "y": 400, "size": 28, "rotation": 0, "color": "#141414", "layer": "Power"},
            {"symbolId": "exhaust", "page": 0, "x": 90, "y": 400, "size": 28, "rotation": 0, "color": "#141414", "layer": "Lighting"},
            {"symbolId": "pendant", "page": 0, "x": 140, "y": 400, "size": 28, "rotation": 0, "color": "#141414", "layer": "Lighting"},
            {"kind": "run", "symbolId": "ledtape", "page": 0, "x1": 40, "y1": 460, "x2": 180, "y2": 460, "color": "#141414", "layer": "Lighting"},
            {"kind": "legend", "page": 0, "x": 12, "y": 12, "width": min(300, layout["width"])},
        ],
        by_id,
    )
    leg_view = pymupdf.open(stream=leg_pdf, filetype="pdf")
    leg_text = leg_view[0].get_text()
    check("dropped legend title", "SYMBOL LEGEND" in leg_text)
    check("dropped legend names the floor plug", "Floor plug" in leg_text)
    check("dropped legend omits the letter mark", "Under cabinet lights" not in leg_text)
    check("dropped legend names the bath fan", "Bath exhaust fan" in leg_text)
    check("dropped legend names the pendant", "Pendant" in leg_text)
    check("dropped legend names a run", "LED tape light" in leg_text)
    check("dropped legend leaves unused symbols off", "Chandelier" not in leg_text and "Duplex outlet" not in leg_text)
    leg_view[0].get_pixmap(dpi=110, alpha=False).save("/tmp/planmarks-tools.png")
    leg_view.close()

    def legend_title(page):
        matrix = page.rotation_matrix
        chars = []
        for block in page.get_text("rawdict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = "".join(char["c"] for char in span.get("chars", []))
                    if "SYMBOL" not in text:
                        continue
                    for char in span["chars"]:
                        box = char["bbox"]
                        point = pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) * matrix
                        chars.append((char["c"], point.x, point.y))
        return chars

    leg_parsed = [
        {"kind": "legend", "page": 0, "x": 12, "y": 12, "width": min(300, layout["width"])},
    ]
    for page_rot in (90, 180, 270):
        turned = pymupdf.open()
        turned.new_page(width=720, height=560)
        turned[0].set_rotation(page_rot)
        turned_bytes = turned.tobytes()
        turned.close()
        turned_pdf = export_pdf(turned_bytes, leg_parsed, by_id)
        turned_doc = pymupdf.open(stream=turned_pdf, filetype="pdf")
        title = legend_title(turned_doc[0])
        dx = title[-1][1] - title[0][1] if title else 0
        dy = title[-1][2] - title[0][2] if title else 0
        check(
            f"sheet /Rotate {page_rot}: legend stays upright",
            bool(title) and dx > 40 and abs(dy) < 2 and title[0][1] < 40 and title[0][2] < 50,
            str(title[:4]),
        )
        turned_doc.close()

    both = pymupdf.open()
    both.new_page(width=720, height=560)
    both.new_page(width=720, height=560)
    both[1].set_rotation(90)
    both_bytes = both.tobytes()
    both.close()
    both_pdf = export_pdf(
        both_bytes,
        [
            {"kind": "legend", "page": 0, "x": 12, "y": 12, "width": min(300, layout["width"])},
            {"kind": "legend", "page": 1, "x": 12, "y": 12, "width": min(300, layout["width"])},
        ],
        by_id,
    )
    both_doc = pymupdf.open(stream=both_pdf, filetype="pdf")
    for index in (0, 1):
        title = legend_title(both_doc[index])
        dx = title[-1][1] - title[0][1] if title else 0
        dy = title[-1][2] - title[0][2] if title else 0
        check(
            f"mixed sheets: legend on page {index + 1} stays upright",
            bool(title) and dx > 40 and abs(dy) < 2,
            str(title[:4]),
        )
    both_doc.close()

    spun_line = export_pdf(
        rotated_bytes,
        [
            {
                "kind": "line",
                "page": 0,
                "x1": 30,
                "y1": visual.height / 2,
                "x2": visual.width - 30,
                "y2": visual.height / 2,
                "color": "#141414",
            }
        ],
        by_id,
    )
    spun_line_doc = pymupdf.open(stream=spun_line, filetype="pdf")
    spun_line_pix = spun_line_doc[0].get_pixmap(dpi=72, alpha=False)
    mid_y = int(visual.height / 2)
    spun_runs = dash_runs(spun_line_pix, 40, int(visual.width) - 40, mid_y)
    spun_dark = [length for dark, length in spun_runs if dark and length >= 3]
    spun_light = [length for dark, length in spun_runs if not dark and length >= 3]
    check("rotated sheet: dashed line follows the view", len(spun_dark) >= 2 and len(spun_light) >= 2, str(spun_runs[:8]))
    check("rotated sheet: line misses the corner", dark_pixels(spun_line_pix, 0, 0, 16, 16) == 0)
    spun_line_doc.close()

    run_ids = {item["id"] for item in lib["symbols"] if item.get("place") == "run"}

    def rejected(raw, needle, runs=None):
        try:
            parse_placements(raw, 1, ids, runs if runs is not None else run_ids)
        except ValueError as exc:
            return needle in str(exc)
        return False

    check(
        "empty note rejected",
        rejected([{"kind": "note", "page": 0, "x": 10, "y": 10, "text": "  ", "size": 12, "color": "#141414"}], "empty"),
    )
    check(
        "short arrow rejected",
        rejected([{"kind": "arrow", "page": 0, "x1": 10, "y1": 10, "x2": 12, "y2": 10, "color": "#141414"}], "too short"),
    )
    check(
        "short run rejected",
        rejected(
            [{"kind": "run", "symbolId": "ucl120", "page": 0, "x1": 10, "y1": 10, "x2": 14, "y2": 10, "color": "#141414"}],
            "too short",
        ),
    )
    check(
        "point symbol is not a run",
        rejected(
            [{"kind": "run", "symbolId": "duplex", "page": 0, "x1": 10, "y1": 10, "x2": 80, "y2": 10, "color": "#141414"}],
            "unknown run",
        ),
    )

    def visual_chars(page, needle):
        found = []
        raw = page.get_text("rawdict")
        matrix = page.rotation_matrix
        for block in raw.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                chars = []
                for span in line.get("spans", []):
                    for char in span.get("chars", []):
                        if needle not in "".join(item["c"] for item in span.get("chars", [])):
                            continue
                        box = char["bbox"]
                        point = pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) * matrix
                        chars.append((char["c"], point.x, point.y))
                text = "".join(char[0] for char in chars)
                if needle in text:
                    found.append(chars)
        return found

    run_page = pymupdf.open()
    run_page.new_page(width=320, height=180)
    run_bytes = run_page.tobytes()
    run_page.close()
    runs = parse_placements(
        [
            {"kind": "run", "symbolId": "ucl120", "page": 0, "x1": 36, "y1": 50, "x2": 250, "y2": 50, "color": "#141414"},
            {"kind": "run", "symbolId": "ledtape", "page": 0, "x1": 250, "y1": 110, "x2": 40, "y2": 110, "color": "#141414"},
        ],
        1,
        ids,
        run_ids,
    )
    run_pdf = export_pdf(run_bytes, runs, by_id)
    run_doc = pymupdf.open(stream=run_pdf, filetype="pdf")
    run_pix = run_doc[0].get_pixmap(dpi=72, alpha=False)
    run_text = run_doc[0].get_text()
    shaft = dash_runs(run_pix, 50, 230, 50)
    shaft_dark = [length for dark, length in shaft if dark and length >= 3]
    shaft_gaps = [length for dark, length in shaft if not dark and length >= 3]
    check("120V run is a solid line", len(shaft_dark) == 1 and shaft_dark[0] > 150, str(shaft[:8]))
    check("120V run is not dashed", len(shaft_gaps) == 0, str(shaft[:8]))
    check("120V end bar rises off the line", dark_pixels(run_pix, 34, 43, 39, 48) > 0)
    check("120V label exports", "120V" in run_text and "TAPE" in run_text)
    volts = visual_chars(run_doc[0], "120V")
    tape_chars = visual_chars(run_doc[0], "TAPE")
    check(
        "120V reads left to right under the line",
        bool(volts) and volts[0][-1][1] > volts[0][0][1] and min(char[2] for char in volts[0]) > 52,
        str(volts),
    )
    check(
        "TAPE stays readable when drawn right to left",
        bool(tape_chars) and tape_chars[0][-1][1] > tape_chars[0][0][1] and min(char[2] for char in tape_chars[0]) > 112,
        str(tape_chars),
    )
    run_doc.close()

    spun_run = export_pdf(
        rotated_bytes,
        [
            {
                "kind": "run",
                "symbolId": "ucl120",
                "page": 0,
                "x1": 24,
                "y1": 70,
                "x2": visual.width - 24,
                "y2": 70,
                "color": "#141414",
            }
        ],
        by_id,
    )
    spun_run_doc = pymupdf.open(stream=spun_run, filetype="pdf")
    spun_run_pix = spun_run_doc[0].get_pixmap(dpi=72, alpha=False)
    spun_volts = visual_chars(spun_run_doc[0], "120V")
    check("rotated sheet: 120V run exports", "120V" in spun_run_doc[0].get_text())
    check(
        "rotated sheet: 120V reads left to right",
        bool(spun_volts) and spun_volts[0][-1][1] > spun_volts[0][0][1] and min(char[2] for char in spun_volts[0]) > 72,
        str(spun_volts),
    )
    check("rotated sheet: run misses the corner", dark_pixels(spun_run_pix, 0, 0, 12, 12) == 0)
    spun_run_doc.close()

    callout = parse_placements(
        [
            {
                "kind": "note",
                "page": 0,
                "x": 36,
                "y": 24,
                "text": "ADD CIRCUIT\nIN GARAGE",
                "size": 14,
                "color": "#141414",
            },
            {"kind": "arrow", "page": 0, "x1": 30, "y1": 90, "x2": 250, "y2": 90, "color": "#141414"},
        ],
        1,
        ids,
    )
    noted = export_pdf(line_bytes, callout, by_id)
    noted_doc = pymupdf.open(stream=noted, filetype="pdf")
    noted_text = noted_doc[0].get_text()
    noted_pix = noted_doc[0].get_pixmap(dpi=72, alpha=False)
    check("note text exports", "ADD CIRCUIT" in noted_text and "IN GARAGE" in noted_text)
    check("note sits near its point", dark_pixels(noted_pix, 30, 20, 180, 70) > 20)
    check("note misses the corner", dark_pixels(noted_pix, 0, 0, 18, 18) == 0)
    arrow_runs = dash_runs(noted_pix, 40, 230, 90)
    arrow_dark = [length for dark, length in arrow_runs if dark and length >= 3]
    arrow_gaps = [length for dark, length in arrow_runs if not dark and length >= 3]
    check("arrow is a solid line", len(arrow_dark) == 1 and arrow_dark[0] > 150, str(arrow_runs[:8]))
    check("arrow is not dashed", len(arrow_gaps) == 0, str(arrow_runs[:8]))
    check("arrow head leaves the shaft", dark_pixels(noted_pix, 236, 93, 242, 96) > 0)
    check("arrow shaft stays thin", dark_pixels(noted_pix, 80, 100, 140, 112) == 0)
    noted_doc.close()

    spun_note = export_pdf(
        rotated_bytes,
        [
            {
                "kind": "note",
                "page": 0,
                "x": 24,
                "y": 40,
                "text": "PANEL",
                "size": 14,
                "color": "#141414",
            },
            {
                "kind": "arrow",
                "page": 0,
                "x1": 30,
                "y1": visual.height / 2,
                "x2": visual.width - 30,
                "y2": visual.height / 2,
                "color": "#141414",
            },
        ],
        by_id,
    )
    spun_note_doc = pymupdf.open(stream=spun_note, filetype="pdf")
    spun_note_pix = spun_note_doc[0].get_pixmap(dpi=72, alpha=False)
    spun_note_text = spun_note_doc[0].get_text()
    check("rotated sheet: note text exports", "PANEL" in spun_note_text)
    check("rotated sheet: note stays at the visual point", dark_pixels(spun_note_pix, 20, 36, 140, 80) > 15)
    check("rotated sheet: note misses the corner", dark_pixels(spun_note_pix, 0, 0, 12, 12) == 0)
    spun_arrow_runs = dash_runs(spun_note_pix, 40, int(visual.width) - 40, mid_y)
    spun_arrow_dark = [length for dark, length in spun_arrow_runs if dark and length >= 3]
    spun_arrow_gaps = [length for dark, length in spun_arrow_runs if not dark and length >= 3]
    check(
        "rotated sheet: arrow follows the view",
        len(spun_arrow_dark) == 1 and spun_arrow_dark[0] > 80,
        str(spun_arrow_runs[:8]),
    )
    check("rotated sheet: arrow is not dashed", len(spun_arrow_gaps) == 0, str(spun_arrow_runs[:8]))
    check("rotated sheet: arrow misses the corner", dark_pixels(spun_note_pix, 0, 0, 16, 16) == 0)
    spun_note_doc.close()

    # Every symbol, plus the sample plan underneath.
    placements = []
    cols = 4
    for index, item in enumerate(lib["symbols"]):
        col, row = index % cols, index // cols
        placements.append(
            {
                "symbolId": item["id"],
                "page": 0,
                "x": 120 + col * 90,
                "y": 150 + row * 100,
                "size": 70,
                "rotation": 25 if item["wall"] else 0,
                "color": item["defaultColor"],
            }
        )
    contact = export_pdf(sample, placements, by_id)
    contact_doc = pymupdf.open(stream=contact, filetype="pdf")
    check("contact keeps plan text", "LIVING" in contact_doc[0].get_text())
    check("contact draws symbol text", "S3" in contact_doc[0].get_text())
    contact_doc[0].get_pixmap(dpi=90, alpha=False).save("/tmp/planmarks-marked.png")
    # Symbol parade on a blank sheet for inspection.
    parade_doc = pymupdf.open()
    parade_rows = (len(lib["symbols"]) + cols - 1) // cols
    parade_doc.new_page(width=720, height=160 + parade_rows * 100)
    parade_bytes = parade_doc.tobytes()
    parade_doc.close()
    parade = export_pdf(parade_bytes, placements, by_id)
    parade_view = pymupdf.open(stream=parade, filetype="pdf")
    parade_view[0].get_pixmap(dpi=110, alpha=False).save("/tmp/planmarks-symbols.png")
    parade_view.close()
    contact_doc.close()

    print("white box, layers, schedule")
    cover_src = pymupdf.open()
    cover_src.new_page(width=200, height=200)
    cover_src[0].draw_rect(pymupdf.Rect(40, 40, 120, 80), color=(0, 0, 0), fill=(0, 0, 0), width=0)
    cover_raw = cover_src.tobytes()
    cover_src.close()
    cover_before = pymupdf.open(stream=cover_raw)
    cover_before_pix = cover_before[0].get_pixmap(dpi=72, alpha=False)
    check("sheet has ink under the white box", dark_pixels(cover_before_pix, 45, 45, 55, 55) > 20)
    cover_before.close()
    cover_parsed = parse_placements(
        [
            {
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 80,
                "y": 60,
                "size": 36,
                "rotation": 0,
                "color": "#141414",
                "layer": "Power",
                "circuit": "A1",
            },
            {
                "kind": "whitebox",
                "page": 0,
                "x1": 36,
                "y1": 36,
                "x2": 124,
                "y2": 84,
                "layer": "Power",
            },
        ],
        1,
        ids,
    )
    check(
        "white box keeps its corners",
        cover_parsed[1]["kind"] == "whitebox" and cover_parsed[1]["x1"] == 36 and cover_parsed[1]["y2"] == 84,
    )
    check("circuit is kept on the symbol", cover_parsed[0]["circuit"] == "A1" and cover_parsed[0]["layer"] == "Power")
    covered = export_pdf(cover_raw, cover_parsed, by_id)
    cover_after = pymupdf.open(stream=cover_raw)
    cover_after_pix = cover_after[0].get_pixmap(dpi=72, alpha=False)
    check("original pdf is not modified", dark_pixels(cover_after_pix, 45, 45, 55, 55) > 20)
    cover_after.close()
    cover_doc = pymupdf.open(stream=covered, filetype="pdf")
    cover_pix = cover_doc[0].get_pixmap(dpi=72, alpha=False)
    check("white box covers the sheet under it", dark_pixels(cover_pix, 44, 44, 54, 54) == 0)
    check("symbol stays above the white box", dark_pixels(cover_pix, 70, 52, 90, 68) > 0)
    check("circuit label stays off unless asked", "A1" not in cover_doc[0].get_text())
    cover_doc.close()
    tagged = export_pdf(cover_raw, cover_parsed, by_id, show_circuits=True)
    tagged_doc = pymupdf.open(stream=tagged, filetype="pdf")
    check("circuit label exports when circuits are shown", "A1" in tagged_doc[0].get_text())
    tagged_doc.close()
    height_src = pymupdf.open()
    height_src.new_page(width=320, height=240)
    height_raw = height_src.tobytes()
    height_src.close()
    height_parsed = parse_placements(
        [
            {
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 70,
                "y": 50,
                "size": 36,
                "rotation": 90,
                "color": "#141414",
                "height": "48",
            },
            {
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 140,
                "y": 50,
                "size": 36,
                "rotation": 0,
                "color": "#141414",
            },
            {
                "kind": "symbol",
                "symbolId": "switch",
                "page": 0,
                "x": 210,
                "y": 50,
                "size": 32,
                "rotation": 0,
                "color": "#141414",
                "height": "9ft",
            },
            {"kind": "legend", "page": 0, "x": 16, "y": 100, "width": 280},
        ],
        1,
        ids,
    )
    check("plain number height is inches", height_parsed[0].get("height") == '48"')
    check("a switch stores a height", height_parsed[2].get("height") == "9ft")
    height_pdf = export_pdf(height_raw, height_parsed, by_id)
    height_doc = pymupdf.open(stream=height_pdf, filetype="pdf")
    height_text = height_doc[0].get_text()
    height_doc.close()
    check("outlet height exports under the symbol", '48"' in height_text, height_text[:300])
    check("legend lists the outlet height on its own", "Duplex outlet 48\"" in height_text, height_text[:500])
    check("legend still lists the outlet that has no height", "Duplex outlet\n" in height_text or "\nDuplex outlet\n" in f"\n{height_text}\n")
    check("switch height exports and is listed", "9ft" in height_text and "Single-pole switch 9ft" in height_text, height_text[:500])
    amps_parsed = parse_placements(
        [
            {
                "kind": "symbol",
                "symbolId": "furnace",
                "page": 0,
                "x": 80,
                "y": 140,
                "size": 36,
                "rotation": 0,
                "color": "#141414",
                "amps": "30",
            },
            {
                "kind": "symbol",
                "symbolId": "furnace",
                "page": 0,
                "x": 160,
                "y": 140,
                "size": 36,
                "rotation": 0,
                "color": "#141414",
            },
            {
                "kind": "symbol",
                "symbolId": "ac",
                "page": 0,
                "x": 240,
                "y": 140,
                "size": 36,
                "rotation": 90,
                "color": "#141414",
                "amps": "40a 240v",
            },
            {
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 40,
                "y": 180,
                "size": 28,
                "rotation": 0,
                "color": "#141414",
                "amps": "20",
            },
            {"kind": "legend", "page": 0, "x": 16, "y": 160, "width": 280},
        ],
        1,
        ids,
    )
    check("plain number ampacity is amps", amps_parsed[0].get("amps") == "30A")
    check("typed ampacity keeps the voltage", amps_parsed[2].get("amps") == "40a 240v")
    check("an outlet can store amps but it is not an equipment rating", amps_parsed[3].get("amps") == "20A")
    amps_src = pymupdf.open()
    amps_src.new_page(width=720, height=640)
    amps_raw = amps_src.tobytes()
    amps_src.close()
    amps_pdf = export_pdf(amps_raw, amps_parsed, by_id)
    amps_doc = pymupdf.open(stream=amps_pdf, filetype="pdf")
    amps_text = amps_doc[0].get_text()
    amps_doc.close()
    check("equipment ampacity exports under the symbol", amps_text.count("30A") >= 2, amps_text[:600])
    check("legend lists the furnace ampacity on its own", "Furnace 30A" in amps_text, amps_text[:700])
    check("legend still lists the furnace that has no ampacity", "\nFurnace\n" in f"\n{amps_text}\n")
    check("a typed rating exports as typed", "40a 240v" in amps_text, amps_text[:700])
    check("outlet ampacity stays off the sheet and the legend", "20A" not in amps_text, amps_text[:700])
    check(
        "tiny white box rejected",
        rejected([{"kind": "whitebox", "page": 0, "x1": 10, "y1": 10, "x2": 12, "y2": 40}], "too small"),
    )
    check(
        "bad amps rejected",
        rejected(
            [{
                "kind": "symbol",
                "symbolId": "furnace",
                "page": 0,
                "x": 40,
                "y": 40,
                "size": 28,
                "color": "#141414",
                "amps": "<script>",
            }],
            "bad amps",
        ),
    )
    check(
        "bad height rejected",
        rejected(
            [{
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 40,
                "y": 40,
                "size": 28,
                "color": "#141414",
                "height": "<script>",
            }],
            "bad height",
        ),
    )

    spun_box = pymupdf.open()
    spun_box.new_page(width=360, height=240)
    spun_box[0].set_rotation(90)
    spun_matrix = spun_box[0].derotation_matrix

    def spun_pt(x, y):
        return pymupdf.Point(x, y) * spun_matrix

    spun_box[0].draw_polyline(
        [spun_pt(20, 20), spun_pt(100, 20), spun_pt(100, 80), spun_pt(20, 80)],
        color=(0, 0, 0),
        fill=(0, 0, 0),
        closePath=True,
        width=0.4,
    )
    spun_box_raw = spun_box.tobytes()
    spun_box.close()
    spun_bare = pymupdf.open(stream=spun_box_raw)
    spun_bare_pix = spun_bare[0].get_pixmap(dpi=72, alpha=False)
    check("rotated patch is ink before the white box", dark_pixels(spun_bare_pix, 30, 30, 50, 50) > 0)
    spun_bare.close()
    spun_covered = export_pdf(
        spun_box_raw,
        parse_placements(
            [{"kind": "whitebox", "page": 0, "x1": 16, "y1": 16, "x2": 110, "y2": 90}],
            1,
            ids,
        ),
        by_id,
    )
    spun_cover_doc = pymupdf.open(stream=spun_covered, filetype="pdf")
    spun_cover_pix = spun_cover_doc[0].get_pixmap(dpi=72, alpha=False)
    check("rotated white box covers the visual patch", dark_pixels(spun_cover_pix, 30, 30, 50, 50) == 0)
    check("rotated white box misses the far corner", dark_pixels(spun_cover_pix, 0, 0, 8, 8) == 0)
    spun_cover_doc.close()

    hidden_page = pymupdf.open()
    hidden_page.new_page(width=640, height=400)
    hidden_bytes = hidden_page.tobytes()
    hidden_page.close()
    hidden_legend = export_pdf(
        hidden_bytes,
        [
            {"symbolId": "duplex", "page": 0, "x": 40, "y": 280, "size": 28, "rotation": 0, "color": "#141414", "layer": "Power"},
            {"symbolId": "pendant", "page": 0, "x": 100, "y": 280, "size": 28, "rotation": 0, "color": "#141414", "layer": "Lighting"},
            {"kind": "legend", "page": 0, "x": 12, "y": 12, "width": 360},
        ],
        by_id,
        hidden_layers=["Lighting"],
    )
    hidden_legend_doc = pymupdf.open(stream=hidden_legend, filetype="pdf")
    hidden_legend_text = hidden_legend_doc[0].get_text()
    check(
        "hidden layer leaves the legend",
        "Duplex outlet" in hidden_legend_text and "Pendant" not in hidden_legend_text,
        hidden_legend_text[:240],
    )
    hidden_legend_doc.close()
    hidden_mark = export_pdf(
        plain_bytes,
        [
            {"symbolId": "duplex", "page": 0, "x": 40, "y": 40, "size": 28, "rotation": 0, "color": "#141414", "layer": "Power"},
            {"symbolId": "ceiling", "page": 0, "x": 100, "y": 40, "size": 28, "rotation": 0, "color": "#141414", "layer": "Lighting"},
        ],
        by_id,
        hidden_layers=["Lighting"],
    )
    hidden_mark_doc = pymupdf.open(stream=hidden_mark, filetype="pdf")
    hidden_pix = hidden_mark_doc[0].get_pixmap(dpi=72, alpha=False)
    check("visible layer still exports", dark_pixels(hidden_pix, 30, 30, 52, 52) > 0)
    check("hidden layer mark is omitted", dark_pixels(hidden_pix, 88, 28, 114, 54) == 0)
    hidden_mark_doc.close()

    ocg_pdf = export_pdf(
        plain_bytes,
        [
            {"symbolId": "duplex", "page": 0, "x": 40, "y": 40, "size": 28, "rotation": 0, "color": "#141414", "layer": "Power"},
            {"symbolId": "ceiling", "page": 0, "x": 100, "y": 40, "size": 28, "rotation": 0, "color": "#141414", "layer": "Lighting"},
        ],
        by_id,
        ocg=True,
        hidden_layers=["Lighting"],
    )
    ocg_doc = pymupdf.open(stream=ocg_pdf, filetype="pdf")
    ocg_flags = {info["name"]: info["on"] for info in ocg_doc.get_ocgs().values()}
    check(
        "export can group layers",
        ocg_flags.get("Power") is True and ocg_flags.get("Lighting") is False,
        str(ocg_flags),
    )
    ocg_pix = ocg_doc[0].get_pixmap(dpi=72, alpha=False)
    check("grouped export still draws the visible symbol", dark_pixels(ocg_pix, 30, 30, 52, 52) > 0)
    ocg_doc.close()

    print("revision export")
    revise_project = {
        "app": "plan-marks",
        "version": 1,
        "pdfName": "room.pdf",
        "pdfId": "room",
        "defaultSize": 28,
        "calibration": None,
        "hiddenLayers": ["Lighting"],
        "showCircuits": False,
        "placements": [
            {
                "id": "s1",
                "kind": "symbol",
                "symbolId": "duplex",
                "page": 0,
                "x": 40,
                "y": 40,
                "size": 28,
                "rotation": 0,
                "color": "#141414",
                "layer": "Power",
            },
            {
                "id": "s2",
                "kind": "symbol",
                "symbolId": "ceiling",
                "page": 0,
                "x": 120,
                "y": 40,
                "size": 28,
                "rotation": 0,
                "color": "#141414",
                "layer": "Lighting",
            },
        ],
    }
    final_pdf = export_pdf(plain_bytes, [revise_project["placements"][0]], by_id)
    final_doc = pymupdf.open(stream=final_pdf, filetype="pdf")
    check("final export has no embedded marks", final_doc.embfile_count() == 0)
    final_pix = final_doc[0].get_pixmap(dpi=72, alpha=False)
    check("final export draws the symbol", dark_pixels(final_pix, 30, 30, 52, 52) > 0)
    final_doc.close()
    revised = export_pdf(
        plain_bytes,
        list(revise_project["placements"]),
        by_id,
        hidden_layers=["Lighting"],
        revise=True,
        project=revise_project,
    )
    revised_doc = pymupdf.open(stream=revised, filetype="pdf")
    check(
        "revision file carries the marks and the unmarked plan",
        set(revised_doc.embfile_names()) == {"plan-marks.json", "plan-marks-source.pdf"},
        str(revised_doc.embfile_names()),
    )
    revised_pix = revised_doc[0].get_pixmap(dpi=72, alpha=False)
    check("revision file looks marked", dark_pixels(revised_pix, 30, 30, 52, 52) > 0)
    check("revision stamp omits the hidden layer", dark_pixels(revised_pix, 108, 28, 134, 54) == 0)
    source_doc = pymupdf.open(stream=revised_doc.embfile_get("plan-marks-source.pdf"), filetype="pdf")
    source_pix = source_doc[0].get_pixmap(dpi=72, alpha=False)
    check("embedded plan has no burned symbol", dark_pixels(source_pix, 30, 30, 52, 52) == 0)
    check("embedded plan is not itself a revision file", source_doc.embfile_count() == 0)
    source_doc.close()
    stored_marks = json.loads(revised_doc.embfile_get("plan-marks.json"))
    check(
        "revision keeps the hidden mark",
        stored_marks.get("version") == 1
        and any(item.get("symbolId") == "ceiling" for item in stored_marks["placements"]),
    )
    revised_doc.close()
    revise_session = Session()
    opened_revise = revise_session.open_pdf(revised, "room-revise.pdf")
    check(
        "opening a revision file restores the marks",
        opened_revise["filename"] == "room.pdf"
        and opened_revise["project"]["placements"][1]["symbolId"] == "ceiling"
        and "project" in opened_revise,
    )
    reopened_pix = revise_session.doc[0].get_pixmap(dpi=72, alpha=False)
    check("reopened revision sheet is unmarked", dark_pixels(reopened_pix, 30, 30, 52, 52) == 0)
    again, again_name = revise_session.export(
        [opened_revise["project"]["placements"][0]],
        by_id,
        hidden_layers=["Lighting"],
        revise=True,
        project=opened_revise["project"],
    )
    again_doc = pymupdf.open(stream=again, filetype="pdf")
    inner = pymupdf.open(stream=again_doc.embfile_get("plan-marks-source.pdf"), filetype="pdf")
    check(
        "a second revision does not nest",
        again_doc.embfile_count() == 2 and inner.embfile_count() == 0 and again_name == "room-revise.pdf",
    )
    inner.close()
    again_doc.close()
    broken = pymupdf.open()
    broken.new_page(width=200, height=200)
    broken.embfile_add("plan-marks.json", b"{}", filename="plan-marks.json")
    broken_bytes = broken.tobytes()
    broken.close()
    damaged = Session().open_pdf(broken_bytes, "broken.pdf")
    check(
        "damaged revision opens as a plain plan",
        "project" not in damaged and "could not be read" in damaged.get("revisionWarning", ""),
        str(damaged.get("revisionWarning")),
    )

    from elecplan.schedule import build_schedule_pdf, parse_schedule_rows

    schedule_rows = parse_schedule_rows(
        [{"circuit": "12", "description": "Duplex outlet (4)", "count": 4, "notes": "Kitchen"}]
    )
    schedule_pdf = build_schedule_pdf(schedule_rows, 612, 792, "Sheet 1")
    schedule_doc = pymupdf.open(stream=schedule_pdf, filetype="pdf")
    schedule_text = schedule_doc[0].get_text()
    check(
        "schedule lists the circuit",
        "PANEL SCHEDULE" in schedule_text and "Duplex outlet" in schedule_text and "Kitchen" in schedule_text and "12" in schedule_text,
        schedule_text[:240],
    )
    schedule_doc.close()
    try:
        parse_schedule_rows([])
        schedule_empty_ok = True
    except ValueError:
        schedule_empty_ok = False
    check("schedule parser allows an empty list", schedule_empty_ok)
    try:
        parse_schedule_rows([{"circuit": "", "description": "Duplex", "count": 1, "notes": ""}])
        blank_circuit_rejected = False
    except ValueError:
        blank_circuit_rejected = True
    check("blank circuit rejected", blank_circuit_rejected)

    cross = [
        {"kind": "line", "page": 0, "x1": 40, "y1": 200, "x2": 360, "y2": 200, "color": "#141414"},
        {"kind": "line", "page": 0, "x1": 200, "y1": 40, "x2": 200, "y2": 360, "color": "#141414"},
    ]
    hops = crossing_hops(cross)
    check(
        "later dashed line hops",
        hops[0] == [] and len(hops[1]) == 1 and 140 < hops[1][0] < 180,
        str(hops),
    )
    parallel = [
        {"kind": "line", "page": 0, "x1": 40, "y1": 80, "x2": 360, "y2": 80, "color": "#141414"},
        {"kind": "line", "page": 0, "x1": 40, "y1": 160, "x2": 360, "y2": 160, "color": "#141414"},
    ]
    check("parallel lines do not hop", not any(crossing_hops(parallel).values()))
    touched = [
        {"kind": "line", "page": 0, "x1": 0, "y1": 50, "x2": 100, "y2": 50, "color": "#141414"},
        {"kind": "line", "page": 0, "x1": 100, "y1": 0, "x2": 100, "y2": 100, "color": "#141414"},
    ]
    check("endpoint crossings do not hop", not any(crossing_hops(touched).values()))
    guided = [
        {"kind": "line", "guide": True, "page": 0, "x1": 0, "y1": 0, "x2": 200, "y2": 0, "color": "#5c6570"},
        {"kind": "line", "page": 0, "x1": 100, "y1": -80, "x2": 100, "y2": 80, "color": "#141414"},
    ]
    check("guide lines do not hop", not any(crossing_hops(guided).values()))
    run_cross = [
        {"kind": "line", "page": 0, "x1": 20, "y1": 80, "x2": 180, "y2": 80, "color": "#141414"},
        {"kind": "run", "page": 0, "x1": 100, "y1": 20, "x2": 100, "y2": 160, "symbolId": "ledtape", "color": "#141414"},
    ]
    run_hops = crossing_hops(run_cross)
    check("a later run hops a dashed line", run_hops[0] == [] and len(run_hops[1]) == 1, str(run_hops))
    blank = pymupdf.open()
    blank.new_page(width=400, height=400)
    blank_bytes = blank.tobytes()
    blank.close()
    check("export draws the hop", curve_count(export_pdf(blank_bytes, cross, {})) >= 2)
    check("export leaves parallel lines straight", curve_count(export_pdf(blank_bytes, parallel, {})) == 0)

    print("server")
    app = App()
    httpd = make_server(app, "127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address[:2]
    base = f"http://{host}:{port}"

    status, _headers, body = request(base, "/")
    home = body
    check("home page", status == 200 and b"Plan Marks" in body, str(status))
    check("layout help is a construction line", b"construction rectangle" in body)
    check("white box tool is on the page", b"White box" in body and b"Add schedule sheet" in body)
    check("export choices are on the page", b"Export to revise" in body and b"Export final" in body)
    check(
        "help notes recovery, gangs, and hops",
        b"planmarks-recovery" in body and b"Group switches" in body and b"hops over" in body and b"65%" in body,
    )
    keep_at = body.find(b'value="keep"')
    drop_at = body.find(b'value="drop"')
    check(
        "bring sheets back is the default button",
        b"autofocus" in body and keep_at != -1 and drop_at != -1 and keep_at < drop_at,
    )
    check(
        "help notes saved sheets, 90 days, and layered white boxes",
        b"90 days" in body and b"bring them back" in body and b"shows the plan again" in body,
    )
    check(
        "help notes the added symbols",
        b"4 in and 6 in cans" in body and b"hardwired EV charger" in body and b"48 in outlets" not in body,
    )
    check(
        "help notes outlet height and most-used symbols",
        b"type a height" in body and b"Most used stays at the top" in body and b'id="heightInput"' in body,
    )
    check(
        "help notes equipment ampacity",
        b"type an ampacity" in body and b'id="ampsInput"' in body,
    )
    check(
        "help notes outlets sit beside the wall",
        b"open side of that line" in body
        and b"lines run out from the wall" in body
        and b"turns to follow the wall" in body,
    )
    check(
        "commands sit on one ribbon",
        b'id="tabHome"' in body
        and b'id="tabSheets"' in body
        and b'id="tabLayers"' in body
        and b'id="tabView"' in body
        and b'id="tabExport"' in body
        and body.count(b'id="openBtn"') == 1
        and body.count(b'id="saveBtn"') == 1
        and body.count(b'id="loadBtn"') == 1
        and body.count(b'id="exportBtn"') == 1
        and body.count(b'id="emptyOpen"') == 1,
    )
    scripts = re.findall(rb'<script src="(/static/[a-z]+\.js)"></script>', home)
    check("page loads every script", len(scripts) == 6 and scripts[-1] == b"/static/app.js", str(scripts))
    status, body = 200, b""
    for src in scripts:
        code, _headers, part = request(base, src.decode())
        status = max(status, code)
        body += part
    check(
        "script",
        status == 200
        and b"function placeAt" in body
        and b"function addCountsSheet" in body
        and b"function followAnchors" in body
        and b"function layoutClick" in body
        and b"function whiteboxClick" in body
        and b"function placeLayer" in body
        and b"function snapToUnderlay" in body
        and b"function snapToGuide" in body
        and b"function writeRecovery" in body
        and b"function groupSwitches" in body
        and b"function nextStackedId" in body
        and b"function symbolHitContains" in body
        and b"GANG_PITCH = 0.6" in body
        and b"HIT_SCALE = 0.65" in body
        and b"function hopPathParts" in body
        and b"guide: true" in body
        and b"Recessed lights placed" not in body,
    )
    status, _headers, body = request(base, "/api/symbols")
    payload = json.loads(body)
    check("symbols api", status == 200 and len(payload["symbols"]) >= 12)
    api_by_id = {item["id"]: item for item in payload["symbols"]}
    check(
        "run symbols reach the palette",
        api_by_id["ucl120"]["place"] == "run"
        and api_by_id["ucl120"]["runLabel"] == "120V"
        and api_by_id["ledtape"]["runLabel"] == "TAPE"
        and api_by_id["duplex"]["place"] == "point",
    )

    status, _headers, body = request(base, "/api/open?name=sample-plan.pdf", data=sample, method="POST")
    info = json.loads(body)
    check("open pdf", status == 200 and info["pageCount"] == 2, body[:200])
    status, _headers, png = request(base, "/api/page/0.png?dpi=72")
    check("render png", status == 200 and png.startswith(b"\x89PNG"), str(status))

    status, _headers, body = request(base, "/api/open?name=bad.pdf", data=b"not a pdf", method="POST")
    check("reject junk", status == 400, body[:160])

    # Re-open the sample, then append a one-page PDF and export.
    status, _headers, _body = request(base, "/api/open?name=First%20Floor.pdf", data=sample, method="POST")
    one = pymupdf.open()
    one.new_page(width=200, height=200)
    one_bytes = one.tobytes()
    one.close()
    status, _headers, body = request(base, "/api/append", data=one_bytes, method="POST")
    added = json.loads(body)
    check("append sheet", status == 200 and added["pageCount"] == 3, body[:200])

    export_body = json.dumps(
        {
            "placements": [
                {"symbolId": "duplex", "page": 0, "x": 200, "y": 220, "size": 36, "rotation": 15, "color": "#141414"},
                {"symbolId": "gfci", "page": 0, "x": 260, "y": 220, "size": 36, "rotation": 0, "color": "#141414"},
                {"symbolId": "switch", "page": 0, "x": 320, "y": 180, "size": 32, "rotation": -20, "color": "#141414"},
                {"symbolId": "ceiling", "page": 0, "x": 220, "y": 300, "size": 40, "rotation": 0, "color": "#141414"},
                {"symbolId": "smoke", "page": 0, "x": 400, "y": 160, "size": 36, "rotation": 0, "color": "#9f1d1d"},
                {"symbolId": "panel", "page": 1, "x": 180, "y": 200, "size": 48, "rotation": 90, "color": "#141414"},
                {"kind": "line", "page": 0, "x1": 220, "y1": 300, "x2": 400, "y2": 160, "color": "#141414"},
                {"kind": "run", "symbolId": "ledtape", "page": 0, "x1": 80, "y1": 80, "x2": 220, "y2": 80, "color": "#141414"},
                {"kind": "legend", "page": 1, "x": 24, "y": 24, "width": 280},
            ]
        }
    ).encode()
    status, headers, pdf = request(
        base,
        "/api/export",
        data=export_body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("export status", status == 200 and pdf.startswith(b"%PDF"), str(status))
    check("export filename", "marked" in headers.get("Content-Disposition", "").lower())
    exported = pymupdf.open(stream=pdf, filetype="pdf")
    check("export page count", exported.page_count == 3)
    check("export keeps room name", "LIVING" in exported[0].get_text() or "KITCHEN" in exported[0].get_text())
    check("export stamps a tape run", "TAPE" in exported[0].get_text())
    dropped_text = exported[1].get_text()
    check("export stamps a dropped legend", "SYMBOL LEGEND" in dropped_text)
    check(
        "dropped legend lists symbols on the plan",
        "Duplex outlet" in dropped_text and "LED tape light" in dropped_text and "Panel" in dropped_text,
        dropped_text[:400],
    )
    check(
        "dropped legend leaves off symbols that were not placed",
        "Floor plug" not in dropped_text and "Chandelier" not in dropped_text,
    )
    status, _headers, body = request(
        base,
        "/api/legend",
        data=b"{}",
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("legend with no symbols is refused", status == 400 and b"no symbols" in body.lower(), body[:160])
    status, _headers, body = request(
        base,
        "/api/legend",
        data=json.dumps({"symbolIds": ["exhaust", "nope", "duplex"]}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    legend_info = json.loads(body)
    check(
        "legend sheet",
        status == 200 and legend_info.get("added", 0) >= 1 and legend_info["pageCount"] == 3 + legend_info["added"],
        body[:200],
    )
    status, _headers, legend_pdf_bytes = request(
        base,
        "/api/export",
        data=b'{"placements":[]}',
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    legend_sheet = pymupdf.open(stream=legend_pdf_bytes, filetype="pdf")
    legend_sheet_text = "\n".join(page.get_text() for page in legend_sheet)
    legend_sheet.close()
    check(
        "legend sheet lists the symbols it was given",
        "Duplex outlet" in legend_sheet_text and "Bath exhaust fan" in legend_sheet_text,
    )
    check(
        "legend sheet leaves unused symbols off",
        "Floor plug" not in legend_sheet_text and "Chandelier" not in legend_sheet_text,
    )

    empty_counts = json.dumps({"scope": "all", "page": 0, "rows": []}).encode()
    status, _headers, body = request(
        base,
        "/api/counts",
        data=empty_counts,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("empty counts rejected", status == 400, body[:160])
    counts_body = json.dumps(
        {
            "scope": "all",
            "page": 0,
            "rows": [
                {"name": "Duplex outlet", "count": 14},
                {"name": "LED tape light", "count": 2},
            ],
        }
    ).encode()
    status, _headers, body = request(
        base,
        "/api/counts",
        data=counts_body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    counts_info = json.loads(body)
    check(
        "counts sheet added",
        status == 200 and counts_info["pageCount"] == legend_info["pageCount"] + counts_info.get("added", 0),
        body[:200],
    )
    status, _headers, counts_pdf = request(
        base,
        "/api/export",
        data=b'{"placements":[]}',
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    counts_doc = pymupdf.open(stream=counts_pdf, filetype="pdf")
    counts_text = counts_doc[-1].get_text()
    check("counts sheet title", "SYMBOL COUNTS" in counts_text and "All sheets" in counts_text, counts_text[:240])
    check("counts sheet lists symbols", "Duplex outlet" in counts_text and "LED tape light" in counts_text)
    check("counts sheet total", "Total" in counts_text and "16" in counts_text, counts_text)
    check(
        "counts sheet leaves the plan",
        "LIVING" in counts_doc[0].get_text() or "KITCHEN" in counts_doc[0].get_text(),
    )
    counts_doc.close()
    sheet_body = json.dumps(
        {"scope": "sheet", "page": 0, "rows": [{"name": "Smoke detector", "count": 3}]}
    ).encode()
    status, _headers, body = request(
        base,
        "/api/counts",
        data=sheet_body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    sheet_info = json.loads(body)
    check(
        "sheet counts added",
        status == 200 and sheet_info["pageCount"] == counts_info["pageCount"] + sheet_info.get("added", 0),
        body[:200],
    )
    status, _headers, sheet_pdf = request(
        base,
        "/api/export",
        data=b'{"placements":[]}',
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    sheet_doc = pymupdf.open(stream=sheet_pdf, filetype="pdf")
    sheet_text = sheet_doc[-1].get_text()
    check("sheet counts names the sheet", "Sheet 1" in sheet_text and "Smoke detector" in sheet_text, sheet_text[:240])
    sheet_doc.close()
    long_rows = [{"name": f"Mark {index}", "count": index} for index in range(1, 80)]
    long_doc = pymupdf.open(stream=build_counts_pdf(long_rows, 400, 300, "All sheets"), filetype="pdf")
    long_text = "\n".join(page.get_text() for page in long_doc)
    check("long counts use more than one page", long_doc.page_count > 1, str(long_doc.page_count))
    check("long counts include the total", "Total" in long_text and "Mark 1" in long_text and "Mark 79" in long_text)
    long_doc.close()
    wide_doc = pymupdf.open(
        stream=build_counts_pdf(
            [{"name": "Duplex outlet", "count": 1}, {"name": "LED tape light", "count": 12}],
            2000,
            1200,
            "Sheet 1",
        ),
        filetype="pdf",
    )
    wide_words = wide_doc[0].get_text("words")
    outlet = next(word for word in wide_words if word[4] == "outlet")
    count_word = next(word for word in wide_words if word[4] == "1" and abs(word[1] - outlet[1]) < 2)
    name_gap = count_word[0] - outlet[2]
    check("count sits beside the name", 8 <= name_gap <= 90, str(round(name_gap, 1)))
    check("count stays off the far edge", count_word[2] < 500, str(round(count_word[2], 1)))
    wide_doc.close()
    legend_pdf = build_legend_pdf(lib["symbols"], 792, 612)
    legend_doc = pymupdf.open(stream=legend_pdf, filetype="pdf")
    legend_text = "\n".join(page.get_text() for page in legend_doc)
    check("legend title", "SYMBOL LEGEND" in legend_text)
    check("legend lists 30A outlet", "30A 240V outlet" in legend_text)
    check("legend lists smurf chase", "Smurf chase" in legend_text)
    check("legend omits the letter-only under cabinet mark", "Under cabinet lights" not in legend_text)
    check("legend lists the 120V run", "Under cabinet 120V" in legend_text and "LED tape light" in legend_text)
    check(
        "legend lists the estimator symbols",
        all(name in legend_text for name in ("Floor plug", "Flood light", "Eave plug", "Patio heater", "Floor heat", "Generator")),
        legend_text[-400:],
    )
    block_pdf, _block_w, _block_h = build_legend_block(lib["symbols"])
    block_doc = pymupdf.open(stream=block_pdf, filetype="pdf")
    block_text = block_doc[0].get_text()
    check("legend block is one page", block_doc.page_count == 1)
    check("legend block lists the pendant", "Pendant" in block_text and "Bath exhaust fan" in block_text)
    block_doc.close()
    legend_doc[0].get_pixmap(dpi=80, alpha=False).save("/tmp/planmarks-legend.png")
    legend_doc.close()
    exported[0].get_pixmap(dpi=80, alpha=False).save("/tmp/planmarks-export.png")
    exported.close()

    bad = json.dumps({"placements": [{"symbolId": "nope", "page": 0, "x": 1, "y": 1, "size": 20}]}).encode()
    status, _headers, body = request(
        base,
        "/api/export",
        data=bad,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("unknown symbol rejected", status == 400, body[:160])

    empty_schedule = json.dumps({"scope": "all", "page": 0, "rows": []}).encode()
    status, _headers, body = request(
        base,
        "/api/schedule",
        data=empty_schedule,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("empty schedule rejected", status == 400, body[:160])
    schedule_body = json.dumps(
        {
            "scope": "sheet",
            "page": 0,
            "rows": [{"circuit": "3", "description": "Duplex outlet (2)", "count": 2, "notes": "Island"}],
        }
    ).encode()
    status, _headers, body = request(
        base,
        "/api/schedule",
        data=schedule_body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    schedule_info = json.loads(body)
    check("schedule sheet added", status == 200 and schedule_info.get("added", 0) >= 1, body[:200])
    status, _headers, schedule_pdf = request(
        base,
        "/api/export",
        data=b'{"placements":[]}',
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    schedule_api_doc = pymupdf.open(stream=schedule_pdf, filetype="pdf")
    schedule_api_text = schedule_api_doc[-1].get_text()
    check(
        "schedule sheet names the circuit",
        "PANEL SCHEDULE" in schedule_api_text and "Island" in schedule_api_text and "Duplex outlet" in schedule_api_text,
        schedule_api_text[:240],
    )
    schedule_api_doc.close()

    status, _headers, body = request(base, "/api/open?name=room-revise.pdf", data=revised, method="POST")
    opened_http = json.loads(body)
    check(
        "open revision over http",
        status == 200
        and opened_http.get("filename") == "room.pdf"
        and opened_http.get("project", {}).get("placements", [{}, {}])[1].get("symbolId") == "ceiling",
        body[:240],
    )
    status, _headers, body = request(
        base,
        "/api/export",
        data=b'{"revise":true,"placements":[]}',
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("revision export needs the marks", status == 400, body[:160])

    status, _headers, body = request(base, "/api/sample.pdf")
    check("sample endpoint", status == 200 and body.startswith(b"%PDF"))

    pdf_id = "0123456789abcdef"
    rec_path = recovery_dir() / f"{pdf_id}.json"
    try:
        payload = json.dumps(
            {
                "app": "plan-marks",
                "version": 1,
                "pdfId": pdf_id,
                "pdfName": "room.pdf",
                "placements": [{"kind": "symbol", "symbolId": "switch", "page": 0, "x": 10, "y": 20, "size": 28}],
            }
        ).encode()
        status, _headers, body = request(
            base,
            "/api/recover",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        saved = json.loads(body)
        check(
            "recovery save",
            status == 200 and saved.get("folder") == "planmarks-recovery" and saved.get("file") == pdf_id + ".json" and saved.get("savedAt"),
            body[:200],
        )
        status, _headers, body = request(base, "/api/recover?id=" + pdf_id)
        loaded = json.loads(body)
        check(
            "recovery load",
            status == 200
            and loaded.get("app") == "plan-marks"
            and loaded.get("version") == 1
            and loaded.get("placements", [{}])[0].get("symbolId") == "switch"
            and loaded.get("savedAt"),
            body[:200],
        )
        status, _headers, body = request(base, "/api/recover?id=not-an-id")
        check("recovery bad id", status == 400, body[:160])
        status, _headers, body = request(base, "/api/recover?id=0000000000000000")
        check("recovery missing", status == 200 and json.loads(body) == {}, body[:160])
        status, _headers, body = request(
            base,
            "/api/recover",
            data=b'{"app":"other"}',
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        check("recovery rejects a foreign file", status == 400, body[:160])
    finally:
        rec_path.unlink(missing_ok=True)
        rec_path.with_suffix(".json.tmp").unlink(missing_ok=True)
        folder = rec_path.parent
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()

    print("added sheets keep the plan id")
    status, _headers, body = request(base, "/api/open?name=keep.pdf", data=sample, method="POST")
    first = json.loads(body)
    plan_id = first["id"]
    kept = recovery_dir() / f"{plan_id}.pdf"
    kept.unlink(missing_ok=True)
    status, _headers, body = request(base, "/api/open?name=keep.pdf", data=sample, method="POST")
    check("no kept sheets yet", status == 200 and "savedSheets" not in json.loads(body), body[:200])
    status, _headers, body = request(base, "/api/append", data=one_bytes, method="POST")
    grown = json.loads(body)
    check("append keeps the id", status == 200 and grown["id"] == plan_id, body[:200])
    check("append keeps the combined plan", kept.is_file() and kept.read_bytes().startswith(b"%PDF"))
    status, _headers, body = request(
        base,
        "/api/counts",
        data=json.dumps({"scope": "all", "rows": [{"name": "Duplex", "count": 2}]}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    check("counts sheet keeps the id", status == 200 and json.loads(body)["id"] == plan_id, body[:200])
    status, _headers, body = request(base, "/api/open?name=keep.pdf", data=sample, method="POST")
    again = json.loads(body)
    check(
        "reopening offers the added sheets",
        again["id"] == plan_id and again["pageCount"] == first["pageCount"] and again.get("savedSheets", {}).get("added") == 2,
        body[:200],
    )
    status, _headers, body = request(base, "/api/sheets/restore", data=b"", method="POST")
    back = json.loads(body)
    check(
        "restore brings the sheets back",
        status == 200 and back["id"] == plan_id and back["pageCount"] == first["pageCount"] + 2,
        body[:200],
    )
    status, _headers, png = request(base, f"/api/page/{back['pageCount'] - 1}.png?dpi=40")
    check("restored sheet renders", status == 200 and png.startswith(b"\x89PNG"))
    status, _headers, body = request(base, "/api/sheets/discard", data=b"", method="POST")
    check("discard the added sheets", status == 200 and not kept.exists(), body[:200])
    status, _headers, body = request(base, "/api/open?name=keep.pdf", data=sample, method="POST")
    check("discarded sheets are not offered", "savedSheets" not in json.loads(body), body[:200])
    status, _headers, body = request(base, "/api/sheets/restore", data=b"", method="POST")
    check("restore with nothing kept", status == 400, body[:200])

    print("added sheets over 80 MB are not kept quietly")
    import elecplan.server as server_mod

    old_limit = server_mod.MAX_PDF_BYTES
    server_mod.MAX_PDF_BYTES = len(one_bytes) + 1
    try:
        status, _headers, body = request(base, "/api/append", data=one_bytes, method="POST")
        warned = json.loads(body)
        check(
            "oversized added sheets warn",
            status == 200 and "80 MB" in warned.get("sheetsWarning", "") and warned.get("added") == 1,
            body[:240],
        )
        check("oversized added sheets are not stored", not (recovery_dir() / f"{plan_id}.pdf").exists())
    finally:
        server_mod.MAX_PDF_BYTES = old_limit
    status, _headers, body = request(base, "/api/open?name=keep.pdf", data=sample, method="POST")
    check("oversized sheets are not offered", status == 200 and "savedSheets" not in json.loads(body), body[:200])

    print("white box erases on final export")

    def words_in(page, rect):
        return [w[4] for w in page.get_text("words") if pymupdf.Rect(w[:4]).intersects(rect)]

    for spin in (0, 90):
        src = pymupdf.open()
        src_page = src.new_page(width=400, height=300)
        src_page.insert_text((60, 100), "SECRET PRICE", fontsize=14)
        src_page.insert_text((60, 220), "KEEP THIS", fontsize=14)
        src_page.draw_line((20, 96), (380, 96), color=(0, 0, 0), width=1)
        src_page.set_rotation(spin)
        src_bytes = src.tobytes()
        hit = pymupdf.Rect(next(w[:4] for w in src_page.get_text("words") if w[4] == "SECRET"))
        hit |= pymupdf.Rect(next(w[:4] for w in src_page.get_text("words") if w[4] == "PRICE"))
        seen = (hit * src_page.rotation_matrix).normalize()
        src.close()
        box = {
            "kind": "whitebox",
            "page": 0,
            "x1": seen.x0 - 4,
            "y1": seen.y0 - 4,
            "x2": seen.x1 + 4,
            "y2": seen.y1 + 4,
        }
        final = pymupdf.open(stream=export_pdf(src_bytes, [box], {}), filetype="pdf")
        fpage = final[0]
        text = fpage.get_text()
        check(f"final erases the text under a box ({spin} deg)", "SECRET" not in text and "PRICE" not in text, text)
        check(f"final keeps the text outside a box ({spin} deg)", "KEEP" in text, text)
        long_lines = [
            item
            for path in fpage.get_drawings()
            for item in path["items"]
            if item[0] == "l" and abs(item[1] - item[2]) > 300
        ]
        check(f"final keeps a wall that crosses a box ({spin} deg)", len(long_lines) == 1, str(long_lines))
        final.close()
        revise = pymupdf.open(
            stream=export_pdf(
                src_bytes,
                [box],
                {},
                revise=True,
                project={"app": "plan-marks", "version": 1, "placements": []},
            ),
            filetype="pdf",
        )
        check(f"revise keeps the sheet whole ({spin} deg)", "SECRET" in revise[0].get_text())
        revise.close()
        hidden = pymupdf.open(
            stream=export_pdf(src_bytes, [{**box, "layer": "Power"}], {}, ocg=True, hidden_layers=["Power"]),
            filetype="pdf",
        )
        check(f"a box on a hidden layer does not erase ({spin} deg)", "SECRET" in hidden[0].get_text())
        hidden.close()
        layered = pymupdf.open(
            stream=export_pdf(src_bytes, [{**box, "layer": "Power"}], {}, ocg=True),
            filetype="pdf",
        )
        layered_page = layered[0]
        white_fills = [
            path
            for path in layered_page.get_drawings()
            if path.get("fill") and all(abs(channel - 1) < 0.01 for channel in path["fill"][:3])
        ]
        check(
            f"export all layers keeps the text under a box ({spin} deg)",
            "SECRET" in layered_page.get_text() and "PRICE" in layered_page.get_text(),
            layered_page.get_text(),
        )
        check(
            f"export all layers still paints the box ({spin} deg)",
            len(white_fills) >= 1,
            str(len(white_fills)),
        )
        layered.close()

    print("requests from other sites")
    loop = {"Host": "127.0.0.1:8765"}
    check("own page is allowed", request_allowed("127.0.0.1", "/api/open", loop))
    check("localhost is allowed", request_allowed("127.0.0.1", "/api/open", {"Host": "localhost:8765"}))
    check("ipv6 loopback is allowed", request_allowed("::1", "/", {"Host": "[::1]:8765"}))
    check(
        "same origin post is allowed",
        request_allowed("127.0.0.1", "/api/export", {**loop, "Origin": "http://127.0.0.1:8765", "Sec-Fetch-Site": "same-origin"}),
    )
    check("a renamed host is refused", not request_allowed("127.0.0.1", "/api/page/0.png", {"Host": "evil.example:8765"}))
    check(
        "another site is refused",
        not request_allowed("127.0.0.1", "/api/open", {**loop, "Origin": "https://evil.example"}),
    )
    check(
        "another local port is refused",
        not request_allowed("127.0.0.1", "/api/recover", {**loop, "Origin": "http://127.0.0.1:3000"}),
    )
    check("a cross-site fetch is refused", not request_allowed("127.0.0.1", "/api/document", {**loop, "Sec-Fetch-Site": "cross-site"}))
    check("a link to the home page still opens", request_allowed("127.0.0.1", "/", {**loop, "Sec-Fetch-Site": "cross-site"}))
    check(
        "a network host takes its own address",
        request_allowed("0.0.0.0", "/api/open", {"Host": "192.168.1.20:8765", "Origin": "http://192.168.1.20:8765"}),
    )
    status, _headers, body = request(base, "/api/document", headers={"Host": "evil.example"})
    check("server refuses a renamed host", status == 403, body[:160])
    status, _headers, body = request(
        base, "/api/recover", data=b"{}", method="POST", headers={"Origin": "https://evil.example", "Content-Type": "text/plain"}
    )
    check("server refuses another site's post", status == 403, body[:160])

    print("old recovery files")
    folder = recovery_dir()
    stale = folder / "aaaaaaaaaaaaaaaa.json"
    stale_pdf = folder / "aaaaaaaaaaaaaaaa.pdf"
    fresh = folder / "bbbbbbbbbbbbbbbb.json"
    other = folder / "notes.txt"
    for path in (stale, stale_pdf, fresh, other):
        path.write_text("{}", encoding="utf-8")
    old = time.time() - 120 * 86400
    for path in (stale, stale_pdf, other):
        os.utime(path, (old, old))
    removed = prune_recovery(90)
    check(
        "old recovery files are removed",
        removed == 2 and not stale.exists() and not stale_pdf.exists() and fresh.exists() and other.exists(),
        str(removed),
    )
    for path in (fresh, other):
        path.unlink(missing_ok=True)

    httpd.shutdown()
    print()
    print(f"{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
