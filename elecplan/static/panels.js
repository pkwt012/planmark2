"use strict";
// Palette, inspector, layers, counts, schedule, size, and color.

function renderPalette() {
  const palette = $("palette");
  const scroll = palette.scrollTop;
  const query = ($("filter").value || "").trim().toLowerCase();
  palette.innerHTML = "";
  for (const cat of library.categories) {
    const items = library.symbols.filter((sym) => {
      if (sym.category !== cat.id) return false;
      if (!query) return true;
      const hay = `${sym.name} ${sym.keywords || ""} ${sym.category}`.toLowerCase();
      return hay.includes(query);
    });
    if (!items.length) continue;
    const section = document.createElement("details");
    section.className = "cat";
    section.open = Boolean(query) || openCategories.has(cat.id);
    const title = document.createElement("summary");
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "▸";
    const label = document.createElement("span");
    label.textContent = cat.name;
    title.append(chev, label);
    section.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const sym of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sym" + (sym.id === state.armedId ? " active" : "");
      btn.title = sym.hint || sym.name;
      const swatch = document.createElement("div");
      swatch.className = "swatch";
      swatch.innerHTML = sym.svg.replaceAll("#141414", sym.defaultColor || "#141414");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = sym.name;
      btn.appendChild(swatch);
      btn.appendChild(name);
      btn.addEventListener("click", () => toggleArm(sym.id));
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    section.addEventListener("toggle", () => {
      if (($("filter").value || "").trim()) return;
      if (section.open) openCategories.add(cat.id);
      else openCategories.delete(cat.id);
      saveLayout();
    });
    palette.appendChild(section);
  }
  if (!palette.children.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No symbols match that filter.";
    palette.appendChild(empty);
  }
  palette.scrollTop = scroll;
}

function buildSymbolSelect() {
  const select = $("symbolSelect");
  select.innerHTML = "";
  for (const sym of library.symbols) {
    if (sym.place === "run") continue;
    const opt = document.createElement("option");
    opt.value = sym.id;
    opt.textContent = sym.name;
    select.appendChild(opt);
  }
}

function buildColors() {
  const box = $("colors");
  box.innerHTML = "";
  for (const color of COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch-btn";
    btn.dataset.value = color.value;
    btn.title = color.name;
    btn.setAttribute("aria-label", color.name);
    btn.setAttribute("aria-pressed", "false");
    if (color.value) btn.style.background = color.value;
    btn.addEventListener("click", () => applyColor(color.value));
    box.appendChild(btn);
  }
}

function clearDrawingTools() {
  state.tool = null;
  state.lineDraft = null;
  state.arrowDraft = null;
  state.runDraft = null;
  state.layoutDraft = null;
  state.whiteboxDraft = null;
  state.calibStep = 0;
  state.calibDraft = null;
}

function toggleArm(id) {
  const sym = symbolsById[id];
  const was = state.armedId === id;
  clearDrawingTools();
  state.armedId = was ? null : id;
  if (state.armedId && isRunSymbol(sym)) state.tool = "run";
  if (state.armedId && sym) {
    openCategories.add(sym.category);
    saveLayout();
  }
  renderPalette();
  syncInspector();
  renderMarks();
  setStatus();
}

function setTool(name) {
  if (!state.doc) return;
  const next = state.tool === name ? null : name;
  clearDrawingTools();
  state.armedId = null;
  state.tool = next;
  renderPalette();
  syncInspector();
  renderMarks();
  setStatus();
}

function sizeText(pt) {
  let text = `${(pt / 72).toFixed(2)}" on the sheet`;
  if (state.calibration) {
    const feet = pt / state.calibration.pointsPerFoot;
    text += ` · ${feet.toFixed(2)} ft on the plan`;
  }
  return text;
}

function syncInspector() {
  const p = selected();
  const sym = state.armedId ? symbolsById[state.armedId] : null;
  const symbolLike = isSymbol(p);
  const hint = $("toolHint");
  if (state.calibStep === 1) hint.textContent = "Click the first end of a known length.";
  else if (state.calibStep === 2) hint.textContent = "Click the other end.";
  else if (state.calibStep === 3) hint.textContent = "Enter how long that distance is, then Apply.";
  else if (state.tool === "line" && state.lineDraft) hint.textContent = "Click the next point. A point on a symbol stays attached. Esc cancels this segment.";
  else if (state.tool === "line") hint.textContent = "Click the first point of a dashed line. Snap it to a symbol to keep that end attached. Esc puts the tool away.";
  else if (state.tool === "layout" && state.layoutDraft) hint.textContent = "Click the opposite corner. Hold Shift for a square. Esc cancels this rectangle.";
  else if (state.tool === "layout") hint.textContent = "Click one corner, then the opposite corner. This draws a construction line. Symbols snap onto it. Esc puts the tool away.";
  else if (state.tool === "whitebox" && state.whiteboxDraft) hint.textContent = "Click the opposite corner. Hold Shift for a square. Esc cancels this white box.";
  else if (state.tool === "whitebox") hint.textContent = "Click one corner, then the opposite corner. The white box covers the plan under the symbols. Esc puts the tool away.";
  else if (state.tool === "arrow" && state.arrowDraft) hint.textContent = "Click where the arrow points. Esc cancels this arrow.";
  else if (state.tool === "arrow") hint.textContent = "Click the first point, then click where the arrow points. Esc puts the tool away.";
  else if (state.tool === "run" && state.runDraft) hint.textContent = "Click the other end. Esc cancels this run.";
  else if (state.tool === "run") hint.textContent = (sym && sym.hint) || "Click one end, then the other. Esc puts the tool away.";
  else if (state.tool === "note") hint.textContent = "Click the sheet, then type a short label. A note is text, so it stays out of the symbol legend and the counts.";
  else if (state.tool === "legend") hint.textContent = "Click the sheet to drop a key of the symbols placed on the plan.";
  else if (sym) hint.textContent = sym.hint || `Click the plan to place ${sym.name}. Esc puts the tool away.`;
  else if (p && p.kind === "line" && p.guide) hint.textContent = "Construction line. Click a symbol, then click the line to place it. Drag the line to move it.";
  else if (p && p.kind === "line") hint.textContent = p.a1 || p.a2
    ? "A blue end stays on its symbol. Drag that end away to disconnect it. Dragging the line also disconnects it."
    : "Drag the line to move it. Drag an amber end to change it.";
  else if (p && p.kind === "arrow") hint.textContent = "Drag the arrow to move it. Drag an amber end to change it.";
  else if (p && p.kind === "run") hint.textContent = "Drag the run to move it. Drag an amber end to change its length.";
  else if (p && p.kind === "note") hint.textContent = "Edit the label here. Drag it on the sheet. Notes are not listed in the legend or the counts.";
  else if (p && p.kind === "legend") hint.textContent = "Drag the legend. The slider changes how wide it is.";
  else if (p && p.kind === "whitebox") hint.textContent = "Drag the white box to move it. Drag an amber corner to resize it. Shift keeps a corner square.";
  else if (p && p.groupId && groupMembers(p.groupId).length >= 2) hint.textContent = "This switch is in a multi-gang box. Drag moves the whole box. Each switch still takes its own dashed line. Ungroup separates them.";
  else if (pickedSwitches().length >= 2) hint.textContent = "Group switches packs these into one box. Each switch still takes its own dashed line.";
  else if (p) hint.textContent = symbolsById[p.symbolId] ? symbolsById[p.symbolId].hint : "Drag to move. Drag the handle to rotate.";
  else hint.textContent = state.doc ? "Pick a symbol, then click the sheet." : "Open a plan, pick a symbol, then click the sheet to place it.";

  const range = $("sizeRange");
  if (p && p.kind === "legend") {
    range.disabled = false;
    range.min = "120";
    range.max = "800";
    range.step = "2";
    if (document.activeElement !== range) range.value = String(Math.round(p.width));
    $("sizeLabel").textContent = "Legend width";
    $("sizeReadout").textContent = sizeText(p.width);
  } else if (p && p.kind === "line") {
    range.disabled = true;
    $("sizeLabel").textContent = "Dashed line";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "arrow") {
    range.disabled = true;
    $("sizeLabel").textContent = "Arrow";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "run") {
    range.disabled = true;
    $("sizeLabel").textContent = "Run length";
    $("sizeReadout").textContent = sizeText(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
  } else if (p && p.kind === "whitebox") {
    range.disabled = true;
    const w = Math.abs(p.x2 - p.x1);
    const h = Math.abs(p.y2 - p.y1);
    $("sizeLabel").textContent = "White box";
    $("sizeReadout").textContent = `${(w / 72).toFixed(2)}" × ${(h / 72).toFixed(2)}"`;
  } else if ((p && p.kind === "note") || (!p && state.tool === "note")) {
    range.disabled = false;
    range.min = "8";
    range.max = "36";
    range.step = "1";
    const noteSize = p ? p.size : state.noteSize;
    if (document.activeElement !== range) range.value = String(Math.round(noteSize));
    $("sizeLabel").textContent = p ? "Note size" : "Size for new notes";
    $("sizeReadout").textContent = `${Math.round(noteSize)} pt`;
  } else {
    range.disabled = false;
    range.min = "10";
    range.max = "160";
    range.step = "1";
    const activeSize = p ? p.size : state.defaultSize;
    if (document.activeElement !== range) range.value = String(Math.round(activeSize));
    $("sizeLabel").textContent = p ? "Selected size" : "Size for new symbols";
    $("sizeReadout").textContent = sizeText(activeSize);
  }
  const noteSizing = Boolean((p && p.kind === "note") || (!p && state.tool === "note"));
  $("sizeOneFoot").disabled = !state.calibration || noteSizing || (p && !symbolLike);
  for (const btn of document.querySelectorAll(".presets [data-size]")) {
    btn.disabled = noteSizing || Boolean(p && !symbolLike);
  }

  const calibState = $("calibState");
  if (state.calibration) {
    calibState.textContent = `Scale ${state.calibration.label}. It applies to every sheet.`;
    $("calibClear").hidden = false;
  } else {
    calibState.textContent = "Scale not set. Calibrate on a dimension line to read sizes in feet.";
    $("calibClear").hidden = true;
  }
  $("calibForm").hidden = state.calibStep !== 3;
  $("calibBtn").textContent = state.calibStep ? "Cancel" : "Calibrate";
  $("lineBtn").classList.toggle("active", state.tool === "line");
  $("lineBtn").setAttribute("aria-pressed", state.tool === "line" ? "true" : "false");
  $("arrowBtn").classList.toggle("active", state.tool === "arrow");
  $("arrowBtn").setAttribute("aria-pressed", state.tool === "arrow" ? "true" : "false");
  $("noteBtn").classList.toggle("active", state.tool === "note");
  $("noteBtn").setAttribute("aria-pressed", state.tool === "note" ? "true" : "false");
  $("layoutBtn").classList.toggle("active", state.tool === "layout");
  $("layoutBtn").setAttribute("aria-pressed", state.tool === "layout" ? "true" : "false");
  $("whiteboxBtn").classList.toggle("active", state.tool === "whitebox");
  $("whiteboxBtn").setAttribute("aria-pressed", state.tool === "whitebox" ? "true" : "false");
  $("dropLegendBtn").classList.toggle("active", state.tool === "legend");
  $("dropLegendBtn").setAttribute("aria-pressed", state.tool === "legend" ? "true" : "false");
  $("circuitsBtn").classList.toggle("active", state.showCircuits);
  $("circuitsBtn").setAttribute("aria-pressed", state.showCircuits ? "true" : "false");
  $("snapToggle").checked = state.snap;
  $("exportLayers").checked = state.exportAllLayers;

  $("applySizeBox").hidden = !symbolLike;
  if (symbolLike) $("applySizeBtn").textContent = `Apply size to all ${symbolName(p.symbolId)}`;
  $("selectionBox").hidden = !p;
  $("symbolField").hidden = !symbolLike;
  $("noteField").hidden = !(p && p.kind === "note");
  $("rotationField").hidden = !symbolLike;
  if (p && p.kind === "note" && document.activeElement !== $("noteText")) {
    $("noteText").value = p.text || "";
  }
  const circuitable = Boolean(p && (symbolLike || p.kind === "run" || p.kind === "note" || (p.kind === "line" && !p.guide)));
  $("circuitField").hidden = !circuitable;
  if (circuitable && document.activeElement !== $("circuitInput")) {
    $("circuitInput").value = p.circuit || "";
  }
  $("freePlaceField").hidden = !symbolLike;
  if (symbolLike) $("freePlace").checked = p.freePlace === true;
  syncLayerField(p);
  $("colors").hidden = Boolean(p && (p.kind === "legend" || p.kind === "whitebox"));
  if (symbolLike) {
    $("symbolSelect").value = p.symbolId;
    if (document.activeElement !== $("rotInput")) $("rotInput").value = String(Math.round(p.rotation || 0));
  }
  for (const btn of $("colors").querySelectorAll(".swatch-btn")) {
    const match = p && p.kind !== "legend" ? btn.dataset.value === (p.color || "") : btn.dataset.value === state.ink;
    btn.setAttribute("aria-pressed", match ? "true" : "false");
  }
  const picked = pickedSwitches();
  const sameSheet = picked.length >= 2 && picked.every((item) => item.page === picked[0].page);
  $("groupBtn").hidden = !(sameSheet && picked.length <= 5);
  const grouped = Boolean(p && p.groupId && groupMembers(p.groupId).length >= 2);
  $("ungroupBtn").hidden = !grouped;
  $("groupRow").hidden = $("groupBtn").hidden && $("ungroupBtn").hidden;
  viewport.classList.toggle("placing", Boolean(state.armedId || state.tool) && !state.calibStep);
}

function syncLayerField(p) {
  const field = $("layerField");
  field.hidden = !p;
  if (!p) return;
  const names = layerNames();
  const select = $("layerSelect");
  const signature = names.join("\n");
  if (select.dataset.sig !== signature) {
    select.dataset.sig = signature;
    select.replaceChildren();
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    const custom = document.createElement("option");
    custom.value = "__custom__";
    custom.textContent = "Custom…";
    select.appendChild(custom);
  }
  const current = layerOf(p);
  const known = names.includes(current);
  if (document.activeElement !== select) select.value = known ? current : "__custom__";
  const customizing = select.value === "__custom__";
  $("layerCustomField").hidden = !customizing;
  if (customizing && document.activeElement !== $("layerCustom")) {
    $("layerCustom").value = known ? "" : current;
  }
}

function renderLayers() {
  const box = $("layerToggles");
  if (!box) return;
  const names = layerNames();
  const signature = names.join("\n");
  if (box.dataset.sig !== signature) {
    box.dataset.sig = signature;
    box.replaceChildren();
    for (const name of names) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.layer = name;
      input.addEventListener("change", () => {
        if (input.checked) state.hiddenLayers.delete(name);
        else state.hiddenLayers.add(name);
        renderMarks();
        syncInspector();
        scheduleSave();
      });
      label.append(input, document.createTextNode(" " + name));
      box.appendChild(label);
    }
  }
  for (const input of box.querySelectorAll("input")) {
    input.checked = !state.hiddenLayers.has(input.dataset.layer);
  }
}

function symbolName(id) {
  const sym = symbolsById[id];
  return (sym && sym.name) || "symbol";
}

function applyScope() {
  const picked = document.querySelector('input[name="applyScope"]:checked');
  return picked && picked.value === "all" ? "all" : "sheet";
}

function applySizeToAll() {
  const p = selected();
  if (!isSymbol(p)) return;
  const scope = applyScope();
  const name = symbolName(p.symbolId);
  const where = scope === "all" ? "" : " on this sheet";
  const others = state.placements.filter((item) => {
    if (item.id === p.id || !isSymbol(item) || item.symbolId !== p.symbolId) return false;
    if (scope === "sheet" && item.page !== p.page) return false;
    return true;
  });
  if (!others.length) {
    toast(`No other ${name} marks${where}.`);
    return;
  }
  const changed = others.filter((item) => item.size !== p.size);
  if (!changed.length) {
    toast(`Those ${name} marks already use this size.`);
    return;
  }
  pushUndo();
  for (const item of changed) item.size = p.size;
  renderMarks();
  syncInspector();
  scheduleSave();
  const n = changed.length;
  toast(`Set size on ${n} ${name} mark${n === 1 ? "" : "s"}.`);
}

function countScope() {
  const picked = document.querySelector('input[name="countScope"]:checked');
  return picked && picked.value === "all" ? "all" : "sheet";
}

function countRows() {
  const scope = countScope();
  const tally = new Map();
  for (const item of state.placements) {
    if (!layerVisible(item)) continue;
    if (item.kind === "note" || item.kind === "arrow" || item.kind === "line" || item.kind === "legend" || item.kind === "whitebox") continue;
    if (!isSymbol(item) && item.kind !== "run") continue;
    if (!item.symbolId) continue;
    if (scope === "sheet" && item.page !== state.pageIndex) continue;
    tally.set(item.symbolId, (tally.get(item.symbolId) || 0) + 1);
  }
  const catIndex = new Map(library.categories.map((cat, index) => [cat.id, index]));
  return [...tally.entries()]
    .map(([id, count]) => {
      const sym = symbolsById[id];
      return { id, count, name: sym ? sym.name : id, category: sym ? sym.category : "" };
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        (catIndex.get(a.category) ?? 99) - (catIndex.get(b.category) ?? 99) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

function renderCounts() {
  const list = $("countsList");
  if (!list) return;
  const rows = countRows();
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "count-name";
    name.textContent = row.name;
    const n = document.createElement("span");
    n.className = "count-n";
    n.textContent = String(row.count);
    li.append(name, n);
    list.appendChild(li);
  }
  $("countsEmpty").hidden = rows.length > 0;
  $("countsSheetBtn").disabled = rows.length === 0;
  const schedule = scheduleRows();
  $("scheduleBtn").disabled = schedule.length === 0;
  renderLayers();
}

function scheduleRows() {
  const groups = new Map();
  for (const item of state.placements) {
    if (!layerVisible(item)) continue;
    const circuit = cleanCircuit(item.circuit);
    if (!circuit) continue;
    if (!groups.has(circuit)) groups.set(circuit, { circuit, names: [], notes: [], legs: 0 });
    const group = groups.get(circuit);
    if (isSymbol(item)) group.names.push(symbolName(item.symbolId));
    else if (item.kind === "run") group.names.push(runLabelOf(item) || symbolName(item.symbolId));
    else if (item.kind === "line" && !item.guide) group.legs += 1;
    else if (item.kind === "note") {
      const text = String(item.text || "").replace(/\s+/g, " ").trim();
      if (text && text !== "Note") group.notes.push(text);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const counts = new Map();
      for (const name of group.names) counts.set(name, (counts.get(name) || 0) + 1);
      const parts = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} (${count})` : name));
      if (group.legs) parts.push(group.legs > 1 ? `Switch leg (${group.legs})` : "Switch leg");
      return {
        circuit: group.circuit,
        description: (parts.join(", ") || "—").slice(0, 160),
        count: group.names.length + group.legs,
        notes: group.notes.join("; ").slice(0, 160),
      };
    })
    .sort((a, b) => a.circuit.localeCompare(b.circuit, undefined, { numeric: true }));
}

async function addScheduleSheet() {
  if (!state.doc) return;
  const rows = scheduleRows();
  if (!rows.length) {
    toast("No circuits to put on a schedule. Type a circuit on a symbol first.");
    return;
  }
  const scope = countScope();
  setBusy(true, "Adding schedule…");
  try {
    const res = await fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, page: state.pageIndex, rows }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    const where = scope === "all" ? "all sheets" : "this sheet";
    sheetsAddedToast(info, `Added a schedule for ${where}.`);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function addCountsSheet() {
  if (!state.doc) return;
  const rows = countRows();
  if (!rows.length) {
    toast("No symbols to put on a counts sheet.");
    return;
  }
  const scope = countScope();
  setBusy(true, "Adding counts…");
  try {
    const res = await fetch("/api/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope,
        page: state.pageIndex,
        rows: rows.map((row) => ({ name: row.name, count: row.count })),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    const where = scope === "all" ? "all sheets" : "this sheet";
    sheetsAddedToast(info, `Added a counts sheet for ${where}.`);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

function setSize(pt, { undo = false } = {}) {
  const p = selected();
  if (p && (p.kind === "line" || p.kind === "arrow" || p.kind === "run" || p.kind === "whitebox")) return;
  if (p && p.kind === "note") {
    pt = clamp(pt, 8, 36);
    if (undo) pushUndo();
    p.size = pt;
    state.noteSize = pt;
    updateMark(p);
    syncInspector();
    scheduleSave();
    return;
  }
  if (!p && state.tool === "note") {
    state.noteSize = clamp(pt, 8, 36);
    syncInspector();
    return;
  }
  if (p && p.kind === "legend") {
    pt = clamp(pt, 120, 800);
    if (undo) pushUndo();
    p.width = pt;
    updateMark(p);
    syncInspector();
    scheduleSave();
    return;
  }
  pt = clamp(pt, 10, 160);
  if (undo) pushUndo();
  if (p) p.size = pt;
  else state.defaultSize = pt;
  if (p) updateMark(p);
  syncInspector();
  scheduleSave();
}

function applyColor(value) {
  const p = selected();
  if (p && (p.kind === "legend" || p.kind === "whitebox")) return;
  if (p) pushUndo();
  state.ink = value;
  const ink = value || "#141414";
  if (state.lineDraft) state.lineDraft.color = ink;
  if (state.arrowDraft) state.arrowDraft.color = ink;
  if (state.runDraft) state.runDraft.color = ink;
  if (p && (p.kind === "line" || p.kind === "arrow" || p.kind === "note")) p.color = ink;
  else if (p) {
    const sym = symbolsById[p.symbolId];
    p.color = value || (sym && sym.defaultColor) || "#141414";
  }
  if (p && p.kind === "note") updateNote(p);
  else if (p && !isSegment(p)) renderMarks();
  else if ((p && isSegment(p)) || state.lineDraft || state.arrowDraft || state.runDraft) renderWires();
  syncInspector();
  scheduleSave();
}

function bumpRotation(delta) {
  const p = selected();
  if (!isSymbol(p)) return;
  pushUndo();
  p.rotation = normRot(p.rotation + delta);
  updateMark(p);
  scheduleSave();
}

function duplicatePlacement(p, dx, dy) {
  const copy = { ...p, id: uid() };
  delete copy.groupId;
  delete copy.gang;
  if (isSegment(p) || isWhitebox(p)) {
    copy.x1 = p.x1 + dx;
    copy.y1 = p.y1 + dy;
    copy.x2 = p.x2 + dx;
    copy.y2 = p.y2 + dy;
    if (copy.kind === "line") {
      copy.a1 = null;
      copy.a2 = null;
    }
  } else {
    copy.x = p.x + dx;
    copy.y = p.y + dy;
  }
  state.placements.push(copy);
  return copy;
}

function duplicateShift(p) {
  if (isSegment(p) || isWhitebox(p)) return 16;
  if (p.kind === "note") return Math.max(18, p.size * 1.6);
  if (p.kind === "legend") return 24;
  return p.size * 0.35;
}

function duplicateSelected() {
  const p = selected();
  if (!p) return;
  pushUndo();
  const shift = duplicateShift(p);
  const copy = duplicatePlacement(p, shift, shift);
  state.selectedId = copy.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function deleteSelected() {
  const p = selected();
  if (!p) return;
  pushUndo();
  releaseAnchors(p.id);
  state.picked.delete(p.id);
  state.placements = state.placements.filter((item) => item.id !== p.id);
  dissolveThinGroups();
  state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}
