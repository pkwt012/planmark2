"""Local HTTP server. PDFs stay in this process; nothing is uploaded."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import pymupdf

from elecplan.counts import build_counts_pdf, parse_count_rows
from elecplan.export import (
    REVISE_MARKS,
    REVISE_SOURCE,
    clean_layer_list,
    export_pdf,
    parse_placements,
    symbol_layer,
)
from elecplan.legend import build_legend_pdf, legend_layout
from elecplan.schedule import build_schedule_pdf, parse_schedule_rows
from elecplan.library import load_symbols, project_root
from elecplan.sample_plan import build_sample_pdf

STATIC = project_root() / "elecplan" / "static"
MAX_PDF_BYTES = 80 * 1024 * 1024
MAX_RECOVERY_BYTES = 8 * 1024 * 1024
RECOVERY_KEEP_DAYS = 90
_PDF_ID = re.compile(r"^[0-9a-f]{16}$")
_RECOVERY_FILE = re.compile(r"^[0-9a-f]{16}\.(json|pdf)(\.tmp)?$")
_PAGE_PATH = re.compile(r"/api/page/(\d+)\.png")
_FITZ = threading.Lock()

_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".json": "application/json",
}


def _clamp_dpi(page, dpi: float) -> int:
    # PyMuPDF 2 requires an integer resolution.
    dpi = min(max(float(dpi), 36), 160)
    long_pt = max(page.rect.width, page.rect.height)
    if long_pt * dpi / 72 > 5000:
        dpi = 5000 * 72 / long_pt
    return int(round(dpi))


def _safe_name(name: str) -> str:
    name = (name or "plan.pdf").replace("\\", "/").split("/")[-1]
    name = name.replace("\x00", "").strip() or "plan.pdf"
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:180]


def _export_name(filename: str, revise: bool) -> str:
    base = filename[:-4] if filename.lower().endswith(".pdf") else filename
    return f"{base}-revise.pdf" if revise else f"{base}-marked.pdf"


def recovery_dir() -> Path:
    """Folder of recovery files. Next to the program, or the project folder.

    PLANMARKS_RECOVERY_DIR points it somewhere else, which the self-test uses
    so it never touches real recovery files.
    """
    override = os.environ.get("PLANMARKS_RECOVERY_DIR")
    if override:
        folder = Path(override)
    elif getattr(sys, "frozen", False):
        folder = Path(sys.executable).resolve().parent / "planmarks-recovery"
    else:
        folder = project_root() / "planmarks-recovery"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def prune_recovery(days: float = RECOVERY_KEEP_DAYS) -> int:
    """Delete recovery files not touched in this many days. Returns how many."""
    try:
        folder = recovery_dir()
    except OSError:
        return 0
    cutoff = time.time() - days * 86400
    removed = 0
    for path in folder.iterdir():
        if not _RECOVERY_FILE.fullmatch(path.name):
            continue
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _sheets_path(pdf_id: str) -> Path:
    if not isinstance(pdf_id, str) or not _PDF_ID.fullmatch(pdf_id):
        raise ValueError("bad id")
    return recovery_dir() / f"{pdf_id}.pdf"


def save_sheets(pdf_id: str, data: bytes) -> None:
    """Keep the plan with its added sheets, so reopening the original brings them back.

    A plan over 80 MB is not kept. An older copy is removed so the next open
    does not offer sheets that no longer match.
    """
    if len(data) > MAX_PDF_BYTES:
        discard_sheets(pdf_id)
        raise ValueError(
            "The added sheets are larger than 80 MB, so they were not kept for next time. "
            "Use Export to revise before you close."
        )
    _write_atomic(_sheets_path(pdf_id), data)


def load_sheets(pdf_id: str) -> bytes | None:
    try:
        path = _sheets_path(pdf_id)
        if not path.is_file():
            return None
        if path.stat().st_size > MAX_PDF_BYTES:
            path.unlink(missing_ok=True)
            return None
        data = path.read_bytes()
    except (OSError, ValueError):
        return None
    return data if data.startswith(b"%PDF") else None


def discard_sheets(pdf_id: str) -> None:
    try:
        _sheets_path(pdf_id).unlink(missing_ok=True)
    except (OSError, ValueError):
        return


def save_recovery(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("app") != "plan-marks" or payload.get("version") != 1:
        raise ValueError("That file is not a Plan Marks project.")
    pdf_id = payload.get("pdfId")
    if not isinstance(pdf_id, str) or not _PDF_ID.fullmatch(pdf_id):
        raise ValueError("This plan has no id to recover.")
    stored = dict(payload)
    stored["savedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = json.dumps(stored, ensure_ascii=False, indent=2)
    if len(text.encode("utf-8")) > MAX_RECOVERY_BYTES:
        raise ValueError("That recovery file is too large.")
    path = recovery_dir() / f"{pdf_id}.json"
    _write_atomic(path, text.encode("utf-8"))
    return {"savedAt": stored["savedAt"], "file": path.name, "folder": "planmarks-recovery"}


def load_recovery(pdf_id: str) -> dict | None:
    if not isinstance(pdf_id, str) or not _PDF_ID.fullmatch(pdf_id):
        raise ValueError("bad id")
    path = recovery_dir() / f"{pdf_id}.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("app") != "plan-marks":
        return None
    return data


def _revision_project(raw) -> dict:
    if not isinstance(raw, dict) or raw.get("app") != "plan-marks" or raw.get("version") != 1:
        raise ValueError("A revision export needs the marks")
    if not isinstance(raw.get("placements"), list):
        raise ValueError("A revision export needs the marks")
    return raw


def _read_revision(doc: pymupdf.Document):
    """Return (project, source bytes), 'damaged', or None for a plain PDF."""
    names = set(doc.embfile_names() or [])
    has_marks = REVISE_MARKS in names
    has_source = REVISE_SOURCE in names
    if not has_marks and not has_source:
        return None
    if not has_marks or not has_source:
        return "damaged"
    try:
        project = json.loads(doc.embfile_get(REVISE_MARKS).decode("utf-8"))
        source = doc.embfile_get(REVISE_SOURCE)
        _revision_project(project)
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, RuntimeError):
        return "damaged"
    if not isinstance(source, (bytes, bytearray)) or not bytes(source).startswith(b"%PDF"):
        return "damaged"
    return project, bytes(source)


def _content_disposition(filename: str) -> str:
    ascii_name = "".join(ch if 32 < ord(ch) < 127 and ch not in '"\\' else "_" for ch in filename)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


class Session:
    def __init__(self):
        self.data: bytes | None = None
        self.doc: pymupdf.Document | None = None
        self.filename = ""
        self.doc_id = ""
        self.cache: OrderedDict = OrderedDict()

    def info(self) -> dict:
        if self.doc is None:
            raise ValueError("No PDF is open")
        pages = []
        with _FITZ:
            for index, page in enumerate(self.doc):
                rect = page.rect
                label = (page.get_label() or "").strip() or str(index + 1)
                pages.append(
                    {
                        "index": index,
                        "width": rect.width,
                        "height": rect.height,
                        "rotation": int(page.rotation),
                        "label": label,
                    }
                )
        return {
            "id": self.doc_id,
            "filename": self.filename,
            "pageCount": len(pages),
            "pages": pages,
        }

    def _remember(self, doc: pymupdf.Document, data: bytes, filename: str) -> None:
        if self.doc is not None:
            self.doc.close()
        self.doc = doc
        self.data = data
        self.filename = filename
        # The id is taken from the file as opened and stays put when sheets
        # are added, so autosave and recovery still match the original PDF.
        self.doc_id = hashlib.sha256(data).hexdigest()[:16]
        self.cache.clear()

    def _offer_saved_sheets(self, extra: dict) -> None:
        """Note sheets added to this plan last time. Caller holds _FITZ."""
        stored = load_sheets(self.doc_id)
        if stored is None or self.doc is None:
            return
        try:
            other = pymupdf.open(stream=stored, filetype="pdf")
        except Exception:
            return
        try:
            added = other.page_count - self.doc.page_count
        finally:
            other.close()
        if added > 0:
            extra["savedSheets"] = {"added": added}

    def open_pdf(self, data: bytes, filename: str) -> dict:
        if not data:
            raise ValueError("That file is empty")
        if len(data) > MAX_PDF_BYTES:
            raise ValueError("That PDF is larger than 80 MB")
        extra: dict = {}
        with _FITZ:
            try:
                doc = pymupdf.open(stream=data, filetype="pdf")
            except Exception as exc:
                raise ValueError("Could not open that file as a PDF") from exc
            if doc.needs_pass and not doc.authenticate(""):
                doc.close()
                raise ValueError("This PDF is password-protected. Remove the password and try again.")
            if doc.page_count < 1:
                doc.close()
                raise ValueError("This PDF has no pages")
            revision = _read_revision(doc)
            if revision == "damaged":
                self._remember(doc, data, _safe_name(filename))
                extra["revisionWarning"] = (
                    "This file looks like a revision export, but the marks could not be read. "
                    "It was opened as a plain plan."
                )
            elif isinstance(revision, tuple):
                project, source = revision
                doc.close()
                if len(source) > MAX_PDF_BYTES:
                    raise ValueError("That PDF is larger than 80 MB")
                try:
                    clean = pymupdf.open(stream=source, filetype="pdf")
                except Exception as exc:
                    raise ValueError("Could not open that file as a PDF") from exc
                if clean.needs_pass and not clean.authenticate(""):
                    clean.close()
                    raise ValueError("This PDF is password-protected. Remove the password and try again.")
                if clean.page_count < 1:
                    clean.close()
                    raise ValueError("This PDF has no pages")
                inner_name = project.get("pdfName") if isinstance(project.get("pdfName"), str) else ""
                self._remember(clean, source, _safe_name(inner_name or filename))
                extra["project"] = project
            else:
                self._remember(doc, data, _safe_name(filename))
            self._offer_saved_sheets(extra)
        info = self.info()
        info.update(extra)
        return info

    def restore_sheets(self) -> dict:
        """Swap in the plan with the sheets that were added last time."""
        if self.doc is None:
            raise ValueError("No PDF is open")
        stored = load_sheets(self.doc_id)
        if stored is None:
            raise ValueError("The added sheets could not be found")
        with _FITZ:
            try:
                other = pymupdf.open(stream=stored, filetype="pdf")
            except Exception as exc:
                raise ValueError("The added sheets could not be read") from exc
            if other.page_count <= self.doc.page_count:
                other.close()
                raise ValueError("The added sheets could not be found")
            self.doc.close()
            self.doc = other
            self.data = stored
            self.cache.clear()
        return self.info()

    def discard_sheets(self) -> None:
        if self.doc is None:
            raise ValueError("No PDF is open")
        discard_sheets(self.doc_id)

    def _append_bytes(self, raw: bytes) -> tuple[int, str]:
        """Add every page of raw to the plan. Caller holds _FITZ.

        Returns the page count added and a warning when the combined plan
        could not be kept in the recovery folder.
        """
        assert self.doc is not None
        try:
            other = pymupdf.open(stream=raw, filetype="pdf")
        except Exception as exc:
            raise ValueError("Could not open that file as a PDF") from exc
        try:
            if other.needs_pass and not other.authenticate(""):
                raise ValueError("That PDF is password-protected. Remove the password and try again.")
            if other.page_count < 1:
                raise ValueError("That PDF has no pages")
            added = other.page_count
            self.doc.insert_pdf(other)
        finally:
            other.close()
        self.data = self.doc.tobytes(deflate=True, garbage=3)
        self.cache.clear()
        warning = ""
        try:
            save_sheets(self.doc_id, self.data)
        except OSError as exc:
            print(f"could not keep the added sheets: {exc}", file=sys.stderr)
            warning = "The added sheets could not be saved for next time. Use Export to revise before you close."
        except ValueError as exc:
            warning = str(exc)
        return added, warning

    def _appended(self, raw: bytes) -> dict:
        with _FITZ:
            added, warning = self._append_bytes(raw)
        info = self.info()
        info["added"] = added
        if warning:
            info["sheetsWarning"] = warning
        return info

    def _sheet_subtitle(self, scope: str, page_index: int) -> tuple[pymupdf.Page, str]:
        """Page to size a generated sheet from, and its subtitle. Caller holds _FITZ."""
        assert self.doc is not None
        if page_index < 0 or page_index >= self.doc.page_count:
            page_index = 0
        page = self.doc[page_index]
        if scope == "all":
            return page, "All sheets"
        number = str(page_index + 1)
        label = (page.get_label() or "").strip()
        return page, label if label and label != number else f"Sheet {number}"

    def append_pdf(self, data: bytes) -> dict:
        if self.doc is None or self.data is None:
            raise ValueError("Open a PDF before adding sheets")
        if not data:
            raise ValueError("That file is empty")
        if len(data) > MAX_PDF_BYTES:
            raise ValueError("That PDF is larger than 80 MB")
        return self._appended(data)

    def append_legend(self, symbols, hidden_layers=None) -> dict:
        if self.doc is None or self.data is None:
            raise ValueError("Open a PDF before adding a legend")
        hidden = set(hidden_layers or [])
        if hidden:
            symbols = [sym for sym in symbols if symbol_layer(sym) not in hidden]
        with _FITZ:
            rect = self.doc[0].rect
            legend = build_legend_pdf(symbols, rect.width, rect.height)
        return self._appended(legend)

    def _sheet_request(self, payload, what: str) -> tuple[str, int]:
        if not isinstance(payload, dict):
            raise ValueError(f"{what} must be an object")
        scope = payload.get("scope") or "sheet"
        if scope not in ("sheet", "all"):
            raise ValueError(f"bad {what} scope")
        try:
            page_index = int(payload.get("page") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"bad {what} page") from exc
        return scope, page_index

    def append_counts(self, payload: dict) -> dict:
        if self.doc is None or self.data is None:
            raise ValueError("Open a PDF before adding a counts sheet")
        scope, page_index = self._sheet_request(payload, "counts")
        rows = parse_count_rows(payload.get("rows"))
        if not rows:
            raise ValueError("There are no symbols to count")
        with _FITZ:
            page, subtitle = self._sheet_subtitle(scope, page_index)
            raw = build_counts_pdf(rows, page.rect.width, page.rect.height, subtitle)
        return self._appended(raw)

    def append_schedule(self, payload: dict) -> dict:
        if self.doc is None or self.data is None:
            raise ValueError("Open a PDF before adding a schedule")
        scope, page_index = self._sheet_request(payload, "schedule")
        rows = parse_schedule_rows(payload.get("rows"))
        if not rows:
            raise ValueError("There are no circuits to schedule")
        with _FITZ:
            page, subtitle = self._sheet_subtitle(scope, page_index)
            raw = build_schedule_pdf(rows, page.rect.width, page.rect.height, subtitle)
        return self._appended(raw)

    def render_page(self, index: int, dpi: float) -> bytes:
        with _FITZ:
            if self.doc is None:
                raise ValueError("No PDF is open")
            if index < 0 or index >= self.doc.page_count:
                raise ValueError("Page out of range")
            page = self.doc[index]
            dpi = _clamp_dpi(page, dpi)
            key = (self.doc_id, index, dpi)
            cached = self.cache.get(key)
            if cached is not None:
                self.cache.move_to_end(key)
                return cached
            pix = page.get_pixmap(dpi=dpi, alpha=False, annots=True)
            data = pix.tobytes("png")
            self.cache[key] = data
            self.cache.move_to_end(key)
            while len(self.cache) > 8:
                self.cache.popitem(last=False)
            return data

    def export(
        self,
        placements,
        symbols_by_id,
        ocg=False,
        hidden_layers=None,
        show_circuits=False,
        revise=False,
        project=None,
    ) -> tuple[bytes, str]:
        if self.data is None or self.doc is None:
            raise ValueError("No PDF is open")
        if revise:
            project = _revision_project(project)
        run_ids = {sid for sid, sym in symbols_by_id.items() if sym.get("place") == "run"}
        parsed = parse_placements(placements, self.doc.page_count, set(symbols_by_id), run_ids)
        with _FITZ:
            pdf = export_pdf(
                self.data,
                parsed,
                symbols_by_id,
                ocg=ocg,
                hidden_layers=hidden_layers,
                show_circuits=show_circuits,
                revise=revise,
                project=project,
            )
        if revise and len(pdf) > MAX_PDF_BYTES:
            raise ValueError("This revision file would be larger than 80 MB. Use Export final for this plan.")
        return pdf, _export_name(self.filename, revise)


class App:
    def __init__(self):
        self.session = Session()
        library = load_symbols()
        self.library = library
        self.symbols_by_id = {item["id"]: item for item in library["symbols"]}
        self.legend = legend_layout(library["symbols"])
        self.sample_pdf: bytes | None = None

    def public_symbols(self) -> dict:
        categories = self.library["categories"]
        symbols = []
        for item in self.library["symbols"]:
            symbols.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "category": item["category"],
                    "wall": item["wall"],
                    "place": item.get("place") or "point",
                    "runLabel": item.get("runLabel") or "",
                    "keywords": item["keywords"],
                    "hint": item["hint"],
                    "defaultColor": item["defaultColor"],
                    "svg": item["svg"],
                }
            )
        return {"categories": categories, "symbols": symbols, "legend": self.legend}

    def sample(self) -> bytes:
        if self.sample_pdf is None:
            with _FITZ:
                self.sample_pdf = build_sample_pdf()
        return self.sample_pdf


_LOOPBACK_NAMES = ("localhost", "127.0.0.1", "::1")


def _is_loopback(address: str) -> bool:
    if address == "localhost":
        return True
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def _host_name(host: str) -> str:
    """Host header without its port, lower case. [::1]:8765 gives ::1."""
    host = (host or "").strip().lower()
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else ""
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def request_allowed(bound_host: str, path: str, headers) -> bool:
    """Only this computer's browser, on this page, may use the server.

    A web page open in another tab could otherwise post to the local port,
    or read plan images through a DNS name pointed at 127.0.0.1.
    """
    host = headers.get("Host") or ""
    if _is_loopback(bound_host) and _host_name(host) not in _LOOPBACK_NAMES:
        return False
    if path.startswith("/api/") or path == "/api":
        if (headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
            return False
        origin = headers.get("Origin")
        if origin is not None:
            if urlparse(origin).netloc.lower() != host.strip().lower():
                return False
    return True


def _make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            try:
                code = int(args[1])
            except (IndexError, TypeError, ValueError):
                code = 0
            if code >= 400:
                super().log_message(fmt, *args)

        def _blocked(self) -> bool:
            path = unquote(urlparse(self.path).path)
            if request_allowed(self.server.server_address[0], path, self.headers):
                return False
            self.close_connection = True
            self._json(403, {"error": "Plan Marks only answers its own page on this computer."})
            return True

        def do_GET(self):
            if self._blocked():
                return
            try:
                self._get()
            except Exception as exc:
                traceback.print_exc()
                self._json(500, {"error": str(exc) or "Something went wrong"})

        def do_POST(self):
            if self._blocked():
                return
            try:
                self._post()
            except Exception as exc:
                traceback.print_exc()
                self._json(500, {"error": str(exc) or "Something went wrong"})

        def _get(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            if path == "/":
                self._file(STATIC / "index.html")
                return
            if path == "/api/symbols":
                self._json(200, app.public_symbols())
                return
            if path == "/api/document":
                try:
                    self._json(200, app.session.info())
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                return
            if path == "/api/recover":
                pdf_id = query.get("id", [""])[0]
                try:
                    data = load_recovery(pdf_id)
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                if data is None:
                    self._json(404, {"error": "No recovery file"})
                    return
                self._json(200, data)
                return
            if path == "/api/sample.pdf":
                data = app.sample()
                self._bytes(200, data, "application/pdf", _content_disposition("sample-plan.pdf"))
                return
            match = _PAGE_PATH.fullmatch(path)
            if match:
                try:
                    dpi = float(query.get("dpi", ["110"])[0])
                except ValueError:
                    dpi = 110
                try:
                    png = app.session.render_page(int(match.group(1)), dpi)
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                self._bytes(200, png, "image/png")
                return
            if path.startswith("/static/"):
                rel = path[len("/static/") :]
                if not rel or ".." in rel.split("/"):
                    self._json(404, {"error": "Not found"})
                    return
                self._file(STATIC / rel)
                return
            self._json(404, {"error": "Not found"})

        def _post(self):
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query)
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length < 0 or length > MAX_PDF_BYTES + 2_000_000:
                # The body is not read, so this connection cannot be reused.
                self.close_connection = True
                self._json(413, {"error": "Upload is too large"})
                return
            body = self.rfile.read(length) if length else b""
            if path == "/api/open":
                name = query.get("name", ["plan.pdf"])[0]
                try:
                    info = app.session.open_pdf(body, name)
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"opened {info['filename']} ({info['pageCount']} sheets)")
                self._json(200, info)
                return
            if path == "/api/append":
                try:
                    info = app.session.append_pdf(body)
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"appended {info.get('added', 0)} sheets")
                self._json(200, info)
                return
            if path == "/api/legend":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}") if body else {}
                    if not isinstance(payload, dict):
                        raise ValueError("legend must be an object")
                    hidden = clean_layer_list(payload.get("hiddenLayers"))
                    info = app.session.append_legend(app.library["symbols"], hidden)
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"added legend ({info.get('added', 0)} sheets)")
                self._json(200, info)
                return
            if path == "/api/counts":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    info = app.session.append_counts(payload)
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"added counts ({info.get('added', 0)} sheets)")
                self._json(200, info)
                return
            if path == "/api/schedule":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    info = app.session.append_schedule(payload)
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"added schedule ({info.get('added', 0)} sheets)")
                self._json(200, info)
                return
            if path == "/api/sheets/restore":
                try:
                    info = app.session.restore_sheets()
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                print(f"brought back added sheets ({info['pageCount']} sheets)")
                self._json(200, info)
                return
            if path == "/api/sheets/discard":
                try:
                    app.session.discard_sheets()
                except ValueError as exc:
                    self._json(400, {"error": str(exc)})
                    return
                self._json(200, {"ok": True})
                return
            if path == "/api/recover":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    info = save_recovery(payload)
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                self._json(200, info)
                return
            if path == "/api/export":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    if not isinstance(payload, dict):
                        raise ValueError("export must be an object")
                    revise = payload.get("revise") is True
                    pdf, name = app.session.export(
                        payload.get("placements", []),
                        app.symbols_by_id,
                        ocg=payload.get("ocg") is True,
                        hidden_layers=clean_layer_list(payload.get("hiddenLayers")),
                        show_circuits=payload.get("showCircuits") is True,
                        revise=revise,
                        project=payload.get("project") if revise else None,
                    )
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                count = len(payload.get("placements") or [])
                print(f"exported {name} with {count} symbols")
                self._bytes(200, pdf, "application/pdf", _content_disposition(name))
                return
            self._json(404, {"error": "Not found"})

        def _json(self, status: int, payload: dict):
            data = json.dumps(payload).encode("utf-8")
            self._bytes(status, data, "application/json; charset=utf-8")

        def _file(self, path: Path):
            root = STATIC.resolve()
            try:
                full = path.resolve()
            except OSError:
                self._json(404, {"error": "Not found"})
                return
            if full != root and root not in full.parents:
                self._json(404, {"error": "Not found"})
                return
            if not full.is_file():
                self._json(404, {"error": "Not found"})
                return
            data = full.read_bytes()
            kind = _TYPES.get(full.suffix.lower(), "application/octet-stream")
            self._bytes(200, data, kind)

        def _bytes(self, status: int, data: bytes, content_type: str, disposition: str | None = None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if disposition:
                self.send_header("Content-Disposition", disposition)
            self.end_headers()
            self.wfile.write(data)

    return Handler


def make_server(app: App, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    handler = _make_handler(app)
    ThreadingHTTPServer.allow_reuse_address = True
    last_error = None
    for candidate in range(port, port + 10):
        try:
            return ThreadingHTTPServer((host, candidate), handler)
        except OSError as exc:
            last_error = exc
            continue
    raise OSError(f"No free port from {port} to {port + 9}") from last_error
