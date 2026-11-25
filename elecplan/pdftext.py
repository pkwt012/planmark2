"""Text helpers shared by the generated sheets."""

from __future__ import annotations

import pymupdf


def fit_text(text: str, fontsize: float, max_width: float, fontname: str = "helv") -> str:
    """Text cut with an ellipsis so it fits max_width points."""
    if pymupdf.get_text_length(text, fontname=fontname, fontsize=fontsize) <= max_width:
        return text
    trimmed = text
    while trimmed and pymupdf.get_text_length(trimmed + "...", fontname=fontname, fontsize=fontsize) > max_width:
        trimmed = trimmed[:-1]
    trimmed = trimmed.rstrip() or text[:1]
    return trimmed + "..."
