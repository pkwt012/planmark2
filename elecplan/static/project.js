"use strict";
// Undo, autosave, recovery files, and loading a marks project.

function snapshot() {
  return JSON.stringify({
    placements: state.placements,
    calibration: state.calibration,
    defaultSize: state.defaultSize,
    selectedId: state.selectedId,
    hiddenLayers: [...state.hiddenLayers],
    showCircuits: state.showCircuits,
  });
}

function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 80) state.undo.shift();
  state.redo.length = 0;
}

function restore(raw) {
  const data = JSON.parse(raw);
  state.placements = data.placements || [];
  state.calibration = data.calibration || null;
  state.defaultSize = data.defaultSize || 28;
  state.selectedId = data.selectedId || null;
  state.picked = new Set();
  state.hiddenLayers = new Set(Array.isArray(data.hiddenLayers) ? data.hiddenLayers : []);
  state.showCircuits = Boolean(data.showCircuits);
  if (state.selectedId && !selected()) state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
}

function projectData() {
  return {
    app: "plan-marks",
    version: 1,
    pdfName: state.doc ? state.doc.filename : "",
    pdfId: state.doc ? state.doc.id : "",
    defaultSize: state.defaultSize,
    calibration: state.calibration,
    placements: state.placements,
    hiddenLayers: [...state.hiddenLayers],
    showCircuits: state.showCircuits,
    basePageCount: state.basePageCount,
    generatedSheets: state.generatedSheets,
  };
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(writeAutosave, 250);
}

function stampedProject() {
  const data = projectData();
  data.savedAt = new Date().toISOString();
  return data;
}

function writeAutosave() {
  if (!state.doc) return;
  try {
    const data = stampedProject();
    localStorage.setItem("planmarks:v1:" + state.doc.id, JSON.stringify(data));
    state.browserSavedAt = data.savedAt;
    setSaveStatus(data.savedAt, false);
  } catch (_err) {
    /* private mode or a full disk */
  }
}

function setSaveStatus(savedAt, browserOnly) {
  const el = $("statusSave");
  if (!el) return;
  if (!state.doc) {
    el.textContent = "";
    return;
  }
  if (browserOnly) {
    el.textContent = "Autosaved in this browser";
    return;
  }
  if (!savedAt) {
    el.textContent = "Autosaved";
    return;
  }
  const when = new Date(savedAt);
  el.textContent = Number.isNaN(when.getTime())
    ? "Autosaved"
    : `Autosaved ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function writeRecovery(keepalive = false) {
  writeAutosave();
  if (!state.doc) return null;
  const body = JSON.stringify(stampedProject());
  if (keepalive && body.length > 60000) return null;
  try {
    const res = await fetch("/api/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: Boolean(keepalive),
    });
    if (!res.ok) throw new Error("save failed");
    const info = await res.json();
    setSaveStatus(info.savedAt || state.browserSavedAt, false);
    return info;
  } catch (_err) {
    setSaveStatus(state.browserSavedAt, true);
    return null;
  }
}

function startRecoveryTimer() {
  if (state.recoveryTimer) return;
  state.recoveryTimer = setInterval(() => {
    if (state.doc) writeRecovery(false);
  }, 75000);
}

function agoText(stamp) {
  const then = Date.parse(stamp);
  if (!Number.isFinite(then)) return "earlier";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins <= 0) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

async function offerRecovery(pdfId, appliedStamp, appliedPlacements) {
  if (!pdfId) return;
  let recovery;
  try {
    const res = await fetch("/api/recover?id=" + encodeURIComponent(pdfId));
    if (!res.ok) return;
    recovery = await res.json();
  } catch (_err) {
    return;
  }
  if (!recovery || recovery.app !== "plan-marks") return;
  const recAt = Date.parse(recovery.savedAt || "");
  if (!Number.isFinite(recAt)) return;
  const manual = Number(localStorage.getItem("planmarks:manualAt:" + pdfId) || 0);
  if (recAt <= manual) return;
  const appliedAt = Date.parse(appliedStamp || "");
  if (Number.isFinite(appliedAt) && recAt <= appliedAt) return;
  if (localStorage.getItem("planmarks:dismiss:" + pdfId) === recovery.savedAt) return;
  const current = appliedPlacements || state.placements;
  if (JSON.stringify(recovery.placements || []) === JSON.stringify(current)) return;
  state.pendingRecovery = recovery;
  const text = $("recoverText");
  const bar = $("recoverBar");
  if (!text || !bar) return;
  text.textContent = `Recovered autosave from ${agoText(recovery.savedAt)} — Restore?`;
  bar.hidden = false;
}

function dismissRecovery() {
  const bar = $("recoverBar");
  if (bar) bar.hidden = true;
  const recovery = state.pendingRecovery;
  state.pendingRecovery = null;
  if (recovery && state.doc && recovery.savedAt) {
    localStorage.setItem("planmarks:dismiss:" + state.doc.id, recovery.savedAt);
  }
}

function restoreRecovery() {
  const recovery = state.pendingRecovery;
  const bar = $("recoverBar");
  if (bar) bar.hidden = true;
  state.pendingRecovery = null;
  if (!recovery) return;
  if (state.doc && recovery.savedAt) {
    localStorage.setItem("planmarks:dismiss:" + state.doc.id, recovery.savedAt);
  }
  applyProject(recovery, { quiet: true });
  toast("Restored the autosave.");
  writeRecovery(false);
}

function applyProject(proj, { quiet = false } = {}) {
  if (!proj || proj.app !== "plan-marks" || proj.version !== 1) {
    toast("That file is not a Plan Marks project.");
    return;
  }
  if (!state.doc) {
    state.pendingProject = proj;
    toast("Open the floor plan PDF and these marks will be placed on it.");
    return;
  }
  pushUndo();
  let skipped = 0;
  const placements = [];
  for (const item of proj.placements || []) {
    const page = Number(item.page);
    if (!Number.isInteger(page) || page < 0 || page >= state.doc.pageCount) {
      skipped += 1;
      continue;
    }
    const color = /^#[0-9a-fA-F]{6}$/.test(item.color || "") ? item.color.toLowerCase() : "#141414";
    if (item.kind === "line" || item.kind === "arrow" || item.kind === "run") {
      const coords = [item.x1, item.y1, item.x2, item.y2].map(Number);
      if (coords.some((n) => !Number.isFinite(n))) {
        skipped += 1;
        continue;
      }
      const length = Math.hypot(coords[2] - coords[0], coords[3] - coords[1]);
      if (item.kind === "arrow" && length < 4) {
        skipped += 1;
        continue;
      }
      if (item.kind === "run" && (length < 8 || !isRunSymbol(symbolsById[item.symbolId]))) {
        skipped += 1;
        continue;
      }
      const mark = {
        id: item.id || uid(),
        kind: item.kind,
        page,
        x1: coords[0],
        y1: coords[1],
        x2: coords[2],
        y2: coords[3],
        color,
      };
      if (item.kind === "run") mark.symbolId = item.symbolId;
      if (item.kind === "line") {
        if (item.guide === true) {
          mark.guide = true;
          mark.a1 = null;
          mark.a2 = null;
        } else {
          mark.a1 = typeof item.a1 === "string" ? item.a1 : null;
          mark.a2 = typeof item.a2 === "string" ? item.a2 : null;
        }
      }
      mark.layer = normalizeLayer(item.layer, defaultLayer(item.kind, item.symbolId, mark.guide));
      const circuit = cleanCircuit(item.circuit);
      if (circuit && !(mark.guide)) mark.circuit = circuit;
      placements.push(mark);
      continue;
    }
    if (item.kind === "whitebox") {
      const coords = [item.x1, item.y1, item.x2, item.y2].map(Number);
      if (coords.some((n) => !Number.isFinite(n)) || Math.abs(coords[2] - coords[0]) < 4 || Math.abs(coords[3] - coords[1]) < 4) {
        skipped += 1;
        continue;
      }
      placements.push({
        id: item.id || uid(),
        kind: "whitebox",
        page,
        x1: coords[0],
        y1: coords[1],
        x2: coords[2],
        y2: coords[3],
        layer: normalizeLayer(item.layer, "Power"),
      });
      continue;
    }
    if (item.kind === "note") {
      const x = Number(item.x);
      const y = Number(item.y);
      const size = Number(item.size);
      const text = cleanNote(item.text);
      if (![x, y, size].every((n) => Number.isFinite(n)) || !text.trim()) {
        skipped += 1;
        continue;
      }
      const note = {
        id: item.id || uid(),
        kind: "note",
        page,
        x,
        y,
        text,
        size: clamp(size, 8, 36),
        color,
        layer: normalizeLayer(item.layer, "Power"),
      };
      const noteCircuit = cleanCircuit(item.circuit);
      if (noteCircuit) note.circuit = noteCircuit;
      placements.push(note);
      continue;
    }
    if (item.kind === "legend") {
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      if (![x, y, width].every((n) => Number.isFinite(n))) {
        skipped += 1;
        continue;
      }
      const legend = {
        id: item.id || uid(),
        kind: "legend",
        page,
        x,
        y,
        width: clamp(width, 40, 2000),
        layer: normalizeLayer(item.layer, "Power"),
      };
      if (item.sheetOnly === true) legend.sheetOnly = true;
      placements.push(legend);
      continue;
    }
    if (!symbolsById[item.symbolId] || symbolsById[item.symbolId].place === "run") {
      skipped += 1;
      continue;
    }
    const symbol = {
      id: item.id || uid(),
      kind: "symbol",
      symbolId: item.symbolId,
      page,
      x: Number(item.x),
      y: Number(item.y),
      size: clamp(Number(item.size) || state.defaultSize, 8, 400),
      rotation: normRot(item.rotation),
      color,
      layer: normalizeLayer(item.layer, defaultLayer("symbol", item.symbolId)),
    };
    const symbolCircuit = cleanCircuit(item.circuit);
    if (symbolCircuit) symbol.circuit = symbolCircuit;
    const height = takesHeight(item.symbolId) ? cleanHeight(item.height, true) : "";
    if (height) symbol.height = height;
    const amps = takesAmps(item.symbolId) ? cleanAmps(item.amps, true) : "";
    if (amps) symbol.amps = amps;
    if (item.freePlace === true) symbol.freePlace = true;
    if (isSwitchSymbol(symbol)) {
      const groupId = typeof item.groupId === "string" ? item.groupId : "";
      const gang = Number(item.gang);
      if (/^[\w-]{1,40}$/.test(groupId) && Number.isInteger(gang) && gang >= 0 && gang <= 4) {
        symbol.groupId = groupId;
        symbol.gang = gang;
      }
    }
    placements.push(symbol);
  }
  state.placements = placements;
  dissolveThinGroups();
  if (Array.isArray(proj.hiddenLayers)) {
    state.hiddenLayers = new Set(
      proj.hiddenLayers.filter((name) => typeof name === "string").map((name) => normalizeLayer(name, "")).filter(Boolean),
    );
  } else {
    state.hiddenLayers = new Set();
  }
  state.showCircuits = proj.showCircuits === true;
  const savedBase = Number(proj.basePageCount);
  if (Number.isInteger(savedBase) && savedBase >= 0 && savedBase <= state.doc.pageCount) {
    state.basePageCount = savedBase;
  }
  if (Array.isArray(proj.generatedSheets)) {
    state.generatedSheets = proj.generatedSheets.filter((sheet) => {
      if (!sheet || typeof sheet !== "object") return false;
      const start = Number(sheet.start);
      const count = Number(sheet.count);
      const kind = sheet.kind;
      if (!Number.isInteger(start) || !Number.isInteger(count) || count < 1) return false;
      if (start < 0 || start >= state.doc.pageCount) return false;
      return kind === "legend" || kind === "counts" || kind === "schedule" || kind === "pdf";
    }).map((sheet) => ({
      kind: sheet.kind,
      start: Number(sheet.start),
      count: Math.min(Number(sheet.count), state.doc.pageCount - Number(sheet.start)),
      scope: sheet.scope === "sheet" ? "sheet" : "all",
      sourcePage: Number.isInteger(Number(sheet.sourcePage)) ? Number(sheet.sourcePage) : 0,
    }));
  }
  sanitizeAnchors();
  if (proj.defaultSize) state.defaultSize = clamp(Number(proj.defaultSize) || 28, 10, 160);
  state.calibration = proj.calibration || null;
  state.selectedId = null;
  state.picked = new Set();
  state.calibStep = 0;
  state.calibDraft = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  if (!quiet && proj.pdfName && proj.pdfName !== state.doc.filename) {
    toast(`Project was saved for ${proj.pdfName}. Marks were applied to this file.`);
  }
  if (skipped) toast("Some marks were skipped because the symbol or sheet is missing.");
}
