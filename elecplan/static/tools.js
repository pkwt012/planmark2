"use strict";
// Placing, calibrating, snapping, drawing tools, switch gangs, and dragging.

function placeAt(cx, cy, shift) {
  const sym = symbolsById[state.armedId];
  const page = currentPage();
  if (!sym || !page) return;
  const pt = clientToPdf(cx, cy);
  if (pt.x < -40 || pt.y < -40 || pt.x > page.width + 40 || pt.y > page.height + 40) return;
  const snapped = snapPlacement(pt, sym.id, false, shift);
  pushUndo();
  const mark = {
    id: uid(),
    kind: "symbol",
    symbolId: sym.id,
    page: state.pageIndex,
    x: snapped.x,
    y: snapped.y,
    size: state.defaultSize,
    rotation: 0,
    color: state.ink || sym.defaultColor || "#141414",
    layer: placeLayer("symbol", sym.id),
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function calibClick(pt) {
  if (state.calibStep === 1) {
    state.calibDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    state.calibStep = 2;
  } else if (state.calibStep === 2) {
    state.calibDraft.x2 = pt.x;
    state.calibDraft.y2 = pt.y;
    const length = Math.hypot(state.calibDraft.x2 - state.calibDraft.x1, state.calibDraft.y2 - state.calibDraft.y1);
    if (length < 2) {
      toast("Those points are too close. Click two ends of the dimension.");
      return;
    }
    state.calibStep = 3;
    requestAnimationFrame(() => $("calibLen").focus());
  }
  syncInspector();
  drawCalib();
  setStatus();
}

function applyCalibration() {
  const draft = state.calibDraft;
  if (!draft) return;
  const distance = Number($("calibLen").value);
  const unit = $("calibUnit").value;
  const pt = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
  if (!(distance > 0) || !Number.isFinite(distance)) {
    toast("Enter a length greater than zero.");
    return;
  }
  let feet = distance;
  if (unit === "in") feet = distance / 12;
  if (unit === "m") feet = distance * 3.280839895;
  const pointsPerFoot = pt / feet;
  const inchesPerFoot = pt / 72 / feet;
  pushUndo();
  state.calibration = {
    page: draft.page,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    distance,
    unit,
    pointsPerFoot,
    label: scaleLabel(inchesPerFoot),
  };
  state.calibStep = 0;
  state.calibDraft = null;
  syncInspector();
  drawCalib();
  scheduleSave();
  setStatus();
  toast(`Scale set to ${state.calibration.label}.`);
}

function cancelCalib() {
  state.calibStep = 0;
  state.calibDraft = null;
  syncInspector();
  drawCalib();
  setStatus();
}

function capturePointer(e) {
  try {
    viewport.setPointerCapture(e.pointerId);
  } catch (_err) {
    // The pointer can already be gone. Move and up listeners on window still run.
  }
}

function startPan(e) {
  state.drag = {
    type: "pan",
    x: e.clientX,
    y: e.clientY,
    panX: state.panX,
    panY: state.panY,
  };
  viewport.classList.add("panning");
  capturePointer(e);
}

function placementOrigin(p) {
  if (isSegment(p) || isWhitebox(p)) return { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 };
  return { x: p.x, y: p.y };
}

function ensureEdgeMap() {
  const page = currentPage();
  if (!page || !pageImg.complete || !pageImg.naturalWidth) return null;
  if (edgeMap && edgeMap.key === state.imageKey) return edgeMap;
  const canvas = document.createElement("canvas");
  canvas.width = pageImg.naturalWidth;
  canvas.height = pageImg.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(pageImg, 0, 0);
  let data;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (_err) {
    return null;
  }
  edgeMap = { key: state.imageKey, data, w: canvas.width, h: canvas.height };
  return edgeMap;
}

function snapToUnderlay(pt) {
  const map = ensureEdgeMap();
  const page = currentPage();
  if (!map || !page) return null;
  const sx = map.w / page.width;
  const sy = map.h / page.height;
  const cx = pt.x * sx;
  const cy = pt.y * sy;
  const radius = SNAP_RADIUS * Math.max(sx, sy);
  const x0 = Math.max(1, Math.floor(cx - radius));
  const y0 = Math.max(1, Math.floor(cy - radius));
  const x1 = Math.min(map.w - 2, Math.ceil(cx + radius));
  const y1 = Math.min(map.h - 2, Math.ceil(cy + radius));
  if (x1 <= x0 || y1 <= y0) return null;
  const lumAt = (x, y) => {
    const i = (y * map.w + x) * 4;
    return map.data[i] * 0.299 + map.data[i + 1] * 0.587 + map.data[i + 2] * 0.114;
  };
  let best = null;
  let bestScore = Infinity;
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const gradient = Math.hypot(lumAt(x + 1, y) - lumAt(x - 1, y), lumAt(x, y + 1) - lumAt(x, y - 1));
      if (gradient < 55) continue;
      const score = Math.sqrt(d2) - Math.min(gradient, 180) / 1000;
      if (score < bestScore) {
        bestScore = score;
        best = { x: x / sx, y: y / sy };
      }
    }
  }
  return best;
}

function snapPlacement(pt, symbolId, freePlace, shift) {
  const guide = snapToGuide(pt, state.pageIndex);
  if (guide) return guide;
  if (!state.snap || shift || symbolSkipsSnap(symbolId, freePlace)) return pt;
  return snapToUnderlay(pt) || pt;
}

function snapPoint(pt, excludeId) {
  let best = null;
  let bestD = 14;
  for (const item of state.placements) {
    if (item.page !== state.pageIndex || item.id === excludeId) continue;
    if (isSegment(item)) {
      for (const [x, y] of [[item.x1, item.y1], [item.x2, item.y2]]) {
        const dist = Math.hypot(pt.x - x, pt.y - y);
        if (dist < bestD) {
          bestD = dist;
          best = { x, y, anchorId: null };
        }
      }
      continue;
    }
    if (item.kind === "legend" || !Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    const dist = Math.hypot(pt.x - item.x, pt.y - item.y);
    if (dist < bestD) {
      bestD = dist;
      best = { x: item.x, y: item.y, anchorId: item.id };
    }
  }
  return best || { x: pt.x, y: pt.y, anchorId: null };
}

function projectOnSegment(pt, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.01) return { x: x1, y: y1, dist: Math.hypot(pt.x - x1, pt.y - y1) };
  const t = Math.max(0, Math.min(1, ((pt.x - x1) * dx + (pt.y - y1) * dy) / len2));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, dist: Math.hypot(pt.x - x, pt.y - y) };
}

function snapToGuide(pt, page) {
  let best = null;
  let bestD = 14;
  for (const item of state.placements) {
    if (item.kind !== "line" || !item.guide || item.page !== page) continue;
    const hit = projectOnSegment(pt, item.x1, item.y1, item.x2, item.y2);
    if (hit.dist < bestD) {
      bestD = hit.dist;
      best = { x: hit.x, y: hit.y };
    }
  }
  return best;
}

function anchorTarget(id, line) {
  if (typeof id !== "string" || !id || id.length > 80 || !line) return null;
  const target = state.placements.find((item) => item.id === id);
  if (!target || target.id === line.id || target.page !== line.page) return null;
  if (isSegment(target) || target.kind === "legend" || target.kind === "whitebox") return null;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
  return target;
}

function sanitizeAnchors() {
  for (const line of state.placements) {
    if (line.kind !== "line" || line.guide) continue;
    const first = anchorTarget(line.a1, line);
    const second = anchorTarget(line.a2, line);
    line.a1 = first ? first.id : null;
    line.a2 = second ? second.id : null;
    if (first) {
      line.x1 = first.x;
      line.y1 = first.y;
    }
    if (second) {
      line.x2 = second.x;
      line.y2 = second.y;
    }
  }
}

function followAnchors(mark) {
  if (!mark || isSegment(mark) || mark.kind === "legend" || mark.kind === "whitebox") return false;
  let moved = false;
  for (const line of state.placements) {
    if (line.kind !== "line" || line.guide || line.page !== mark.page) continue;
    if (line.a1 === mark.id) {
      line.x1 = mark.x;
      line.y1 = mark.y;
      moved = true;
    }
    if (line.a2 === mark.id) {
      line.x2 = mark.x;
      line.y2 = mark.y;
      moved = true;
    }
  }
  return moved;
}

function releaseAnchors(id) {
  for (const line of state.placements) {
    if (line.kind !== "line") continue;
    if (line.a1 === id) line.a1 = null;
    if (line.a2 === id) line.a2 = null;
  }
}

function squareCorner(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sy = dy === 0 ? 1 : Math.sign(dy);
  return { x: x1 + sx * side, y: y1 + sy * side };
}

function addLayoutDraft(parent) {
  const draft = state.layoutDraft;
  if (!draft) return;
  let x2 = draft.x2;
  let y2 = draft.y2;
  if (draft.square) {
    const corner = squareCorner(draft.x1, draft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const corners = [
    [draft.x1, draft.y1],
    [x2, draft.y1],
    [x2, y2],
    [draft.x1, y2],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    addWireLine(parent, { x1: start[0], y1: start[1], x2: end[0], y2: end[1] }, "wire-ink", "#5c6570", 0.9, "none", "2.5 2.5");
  }
}

function layoutClick(pt, shift) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  if (!state.layoutDraft) {
    state.layoutDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, square: false };
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  let x2 = pt.x;
  let y2 = pt.y;
  if (shift) {
    const corner = squareCorner(state.layoutDraft.x1, state.layoutDraft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const left = Math.min(state.layoutDraft.x1, x2);
  const right = Math.max(state.layoutDraft.x1, x2);
  const top = Math.min(state.layoutDraft.y1, y2);
  const bottom = Math.max(state.layoutDraft.y1, y2);
  if (right - left < 8 || bottom - top < 8) {
    toast("That layout is too small. Click the opposite corner.");
    return;
  }
  pushUndo();
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    state.placements.push({
      id: uid(),
      kind: "line",
      page: state.layoutDraft.page,
      x1: start[0],
      y1: start[1],
      x2: end[0],
      y2: end[1],
      color: "#5c6570",
      a1: null,
      a2: null,
      guide: true,
      layer: placeLayer("line", null, true),
    });
  }
  state.layoutDraft = null;
  state.selectedId = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  toast("Construction rectangle added. Click a symbol, then click the line to place it.");
}

function addWhiteboxDraft(parent) {
  const draft = state.whiteboxDraft;
  if (!draft) return;
  let x2 = draft.x2;
  let y2 = draft.y2;
  if (draft.square) {
    const corner = squareCorner(draft.x1, draft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  const rect = document.createElementNS(SVGNS, "rect");
  rect.setAttribute("x", String(Math.min(draft.x1, x2)));
  rect.setAttribute("y", String(Math.min(draft.y1, y2)));
  rect.setAttribute("width", String(Math.abs(x2 - draft.x1)));
  rect.setAttribute("height", String(Math.abs(y2 - draft.y1)));
  rect.setAttribute("fill", "#ffffff");
  rect.setAttribute("stroke", "#e2a23a");
  rect.setAttribute("stroke-width", "1");
  rect.setAttribute("stroke-dasharray", "4 3");
  rect.setAttribute("pointer-events", "none");
  parent.appendChild(rect);
}

function whiteboxClick(pt, shift) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  if (!state.whiteboxDraft) {
    state.whiteboxDraft = { page: state.pageIndex, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, square: false };
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  let x2 = pt.x;
  let y2 = pt.y;
  if (shift) {
    const corner = squareCorner(state.whiteboxDraft.x1, state.whiteboxDraft.y1, x2, y2);
    x2 = corner.x;
    y2 = corner.y;
  }
  if (Math.abs(x2 - state.whiteboxDraft.x1) < 8 || Math.abs(y2 - state.whiteboxDraft.y1) < 8) {
    toast("That white box is too small. Click the opposite corner.");
    return;
  }
  pushUndo();
  const mark = {
    id: uid(),
    kind: "whitebox",
    page: state.whiteboxDraft.page,
    x1: state.whiteboxDraft.x1,
    y1: state.whiteboxDraft.y1,
    x2,
    y2,
    layer: placeLayer("whitebox"),
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  state.whiteboxDraft = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function onSheet(pt, page) {
  return pt.x >= -80 && pt.y >= -80 && pt.x <= page.width + 80 && pt.y <= page.height + 80;
}

function segmentClick(pt, kind) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  const key = kind === "arrow" ? "arrowDraft" : kind === "run" ? "runDraft" : "lineDraft";
  const snapped = snapPoint(pt);
  const draft = state[key];
  if (!draft) {
    const sym = kind === "run" ? symbolsById[state.armedId] : null;
    if (kind === "run" && !isRunSymbol(sym)) return;
    state[key] = {
      kind,
      page: state.pageIndex,
      x1: snapped.x,
      y1: snapped.y,
      x2: snapped.x,
      y2: snapped.y,
      color: state.ink || (sym && sym.defaultColor) || "#141414",
    };
    if (kind === "run") state[key].symbolId = sym.id;
    if (kind === "line") state[key].a1 = snapped.anchorId || null;
    if (kind === "line" || kind === "run") state[key].anchorStart = snapped.anchorId || null;
    renderWires();
    syncInspector();
    setStatus();
    return;
  }
  draft.x2 = snapped.x;
  draft.y2 = snapped.y;
  const length = Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1);
  const minLength = kind === "run" ? 8 : 4;
  if (length < minLength) {
    if (kind === "arrow") toast("That arrow is too short. Click where it points.");
    else if (kind === "run") toast("That run is too short. Click the other end.");
    else toast("That line is too short. Click a second point.");
    return;
  }
  pushUndo();
  const mark = {
    id: uid(),
    kind,
    page: draft.page,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    color: draft.color,
  };
  if (kind === "run") mark.symbolId = draft.symbolId;
  if (kind === "line") {
    mark.a1 = draft.a1 || null;
    mark.a2 = snapped.anchorId || null;
  }
  mark.layer = placeLayer(kind, mark.symbolId, false);
  if (kind === "line" || kind === "run") {
    const inherited = circuitFromAnchor(snapped.anchorId) || circuitFromAnchor(draft.anchorStart);
    if (inherited) mark.circuit = inherited;
  }
  state.placements.push(mark);
  state.selectedId = mark.id;
  state[key] = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function circuitFromAnchor(id) {
  if (!id) return "";
  const target = placement(id);
  if (!target || isSegment(target)) return "";
  return cleanCircuit(target.circuit);
}

function placeNote(pt) {
  const page = currentPage();
  if (!page || !onSheet(pt, page)) return;
  const snapped = snapPoint(pt);
  pushUndo();
  const mark = {
    id: uid(),
    kind: "note",
    page: state.pageIndex,
    x: snapped.x,
    y: snapped.y,
    text: "Note",
    size: state.noteSize || 12,
    color: state.ink || "#141414",
    layer: placeLayer("note"),
  };
  state.placements.push(mark);
  state.selectedId = mark.id;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  requestAnimationFrame(() => {
    const box = $("noteText");
    if (!box || selected() !== mark) return;
    box.focus();
    box.select();
  });
}

function placeLegend(pt) {
  const page = currentPage();
  const lay = visibleLegendLayout();
  if (!page || !lay) {
    toast("The legend is not available. Restart the app and try again.");
    return;
  }
  if (!onSheet(pt, page)) return;
  let width = lay.width;
  let height = lay.height;
  const maxW = Math.max(120, page.width - 24);
  const maxH = Math.max(80, page.height - 24);
  if (width > maxW) {
    height *= maxW / width;
    width = maxW;
  }
  if (height > maxH) {
    width *= maxH / height;
    height = maxH;
  }
  const x = clamp(pt.x, 8, Math.max(8, page.width - width - 8));
  const y = clamp(pt.y, 8, Math.max(8, page.height - height - 8));
  pushUndo();
  const mark = { id: uid(), kind: "legend", page: state.pageIndex, x, y, width, layer: placeLayer("legend") };
  state.placements.push(mark);
  state.selectedId = mark.id;
  state.tool = null;
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
  toast("Legend placed. Drag it where the crew can read it.");
}

function groupMembers(groupId) {
  if (!groupId) return [];
  return state.placements.filter((item) => item.groupId === groupId && isSwitchSymbol(item));
}

function dissolveThinGroups() {
  const counts = new Map();
  for (const item of state.placements) {
    if (!item.groupId || !isSwitchSymbol(item)) continue;
    counts.set(item.groupId, (counts.get(item.groupId) || 0) + 1);
  }
  for (const item of state.placements) {
    if (!item.groupId) continue;
    if (!isSwitchSymbol(item) || (counts.get(item.groupId) || 0) < 2) {
      delete item.groupId;
      delete item.gang;
    }
  }
}

function pickedSwitches() {
  const items = [];
  for (const id of state.picked) {
    const item = placement(id);
    if (isSwitchSymbol(item)) items.push(item);
  }
  return items;
}

function groupAxis(items) {
  let best = 0;
  let axis = { x: 1, y: 0 };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const dx = items[j].x - items[i].x;
      const dy = items[j].y - items[i].y;
      const dist = Math.hypot(dx, dy);
      if (dist > best) {
        best = dist;
        axis = dist < 0.01 ? { x: 1, y: 0 } : { x: dx / dist, y: dy / dist };
      }
    }
  }
  return axis;
}

function sortedOnAxis(items, axis) {
  return [...items].sort((a, b) => (a.x * axis.x + a.y * axis.y) - (b.x * axis.x + b.y * axis.y));
}

function switchesAreAdjacent(items) {
  if (items.length < 2 || items.length > 5) return false;
  const page = items[0].page;
  if (items.some((item) => item.page !== page)) return false;
  const sorted = sortedOnAxis(items, groupAxis(items));
  const minSize = Math.min(...sorted.map((item) => item.size || 28));
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.hypot(sorted[i].x - sorted[i - 1].x, sorted[i].y - sorted[i - 1].y);
    if (gap > minSize * 2.4) return false;
  }
  return true;
}

function gangLayouts() {
  const groups = new Map();
  for (const item of state.placements) {
    if (item.page !== state.pageIndex || !layerVisible(item) || !item.groupId || !isSwitchSymbol(item)) continue;
    if (!groups.has(item.groupId)) groups.set(item.groupId, []);
    groups.get(item.groupId).push(item);
  }
  const boxes = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const item of members) {
      left = Math.min(left, item.x - item.size / 2);
      top = Math.min(top, item.y - item.size / 2);
      right = Math.max(right, item.x + item.size / 2);
      bottom = Math.max(bottom, item.y + item.size / 2);
    }
    const pad = 1.5;
    boxes.push({
      left: left - pad,
      top: top - pad,
      width: right - left + pad * 2,
      height: bottom - top + pad * 2,
    });
  }
  return boxes;
}

function paintGangBoxes() {
  if (!marksLayer) return;
  for (const old of marksLayer.querySelectorAll(".gang-box")) old.remove();
  const first = marksLayer.firstChild;
  for (const box of gangLayouts()) {
    const el = document.createElement("div");
    el.className = "gang-box";
    el.style.left = box.left + "px";
    el.style.top = box.top + "px";
    el.style.width = box.width + "px";
    el.style.height = box.height + "px";
    marksLayer.insertBefore(el, first);
  }
}

function togglePick(p) {
  if (!isSwitchSymbol(p)) return;
  const adding = !state.picked.has(p.id);
  const current = selected();
  if (adding && state.picked.size === 0 && current && current.id !== p.id && current.page === p.page && isSwitchSymbol(current)) {
    state.picked.add(current.id);
  }
  if (adding) state.picked.add(p.id);
  else state.picked.delete(p.id);
  state.selectedId = p.id;
  renderMarks();
  syncInspector();
  setStatus();
}

function groupSwitches() {
  const items = pickedSwitches();
  if (items.length < 2 || items.length > 5) {
    toast("Shift-click two to five switches, then group them.");
    return;
  }
  if (items.some((item) => item.page !== items[0].page)) {
    toast("Group switches that are on the same sheet.");
    return;
  }
  if (!switchesAreAdjacent(items)) {
    toast("Those switches are too far apart to share one box.");
    return;
  }
  pushUndo();
  const axis = groupAxis(items);
  const sorted = sortedOnAxis(items, axis);
  const pitch = (sorted.reduce((sum, item) => sum + item.size, 0) / sorted.length) * GANG_PITCH;
  const cx = sorted.reduce((sum, item) => sum + item.x, 0) / sorted.length;
  const cy = sorted.reduce((sum, item) => sum + item.y, 0) / sorted.length;
  const mid = (sorted.length - 1) / 2;
  const groupId = uid();
  sorted.forEach((item, index) => {
    const along = (index - mid) * pitch;
    item.x = cx + axis.x * along;
    item.y = cy + axis.y * along;
    item.groupId = groupId;
    item.gang = index;
    followAnchors(item);
  });
  state.selectedId = sorted[0].id;
  state.picked = new Set(sorted.map((item) => item.id));
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function ungroupSwitches() {
  const current = selected();
  const members = current && current.groupId ? groupMembers(current.groupId) : [];
  if (members.length < 2) return;
  pushUndo();
  for (const item of members) {
    delete item.groupId;
    delete item.gang;
  }
  renderMarks();
  syncInspector();
  scheduleSave();
  setStatus();
}

function moveWithGroup(drag, dx, dy, shift) {
  const primary = placement(drag.id);
  const origin = (drag.origins || []).find((item) => item.id === drag.id);
  if (!primary || !origin) return;
  let x = origin.x + dx;
  let y = origin.y + dy;
  if (isSymbol(primary)) {
    const snapped = snapPlacement({ x, y }, primary.symbolId, primary.freePlace, shift);
    x = snapped.x;
    y = snapped.y;
  }
  const adx = x - origin.x;
  const ady = y - origin.y;
  let wired = false;
  for (const item of drag.origins) {
    const mate = placement(item.id);
    if (!mate || isSegment(mate) || isWhitebox(mate)) continue;
    mate.x = item.x + adx;
    mate.y = item.y + ady;
    if (followAnchors(mate)) wired = true;
    const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(mate.id)}"]`);
    if (el) positionMark(el, mate);
  }
  if (wired) renderWires();
  paintGangBoxes();
}

function startMove(e, id, startPdf) {
  let p = placement(id);
  if (!p) return;
  const previousId = state.selectedId;
  state.selectedId = id;
  let undoOnMove = true;
  if (e.altKey) {
    pushUndo();
    p = duplicatePlacement(p, 0, 0);
    state.selectedId = p.id;
    undoOnMove = false;
  }
  const pdf = startPdf || clientToPdf(e.clientX, e.clientY);
  const mates = !e.altKey && p.groupId && isSwitchSymbol(p) ? groupMembers(p.groupId) : [p];
  const stack = isSymbol(p) && !e.altKey && !e.shiftKey ? symbolsAt(pdf.x, pdf.y) : [];
  state.picked = new Set();
  state.drag = {
    type: "move",
    id: p.id,
    previousId,
    stack,
    startX: pdf.x,
    startY: pdf.y,
    origin: placementOrigin(p),
    origins: mates.map((item) => ({ id: item.id, ...placementOrigin(item) })),
    moved: false,
    alt: e.altKey,
    undo: undoOnMove,
  };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startEnd(e, id, end) {
  state.selectedId = id;
  state.drag = { type: "end", id, end, undo: true, moved: false };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startBoxResize(e, id, corner) {
  const p = placement(id);
  if (!isWhitebox(p)) return;
  state.selectedId = id;
  const b = boxBounds(p);
  const fixed = [
    [b.right, b.bottom],
    [b.left, b.bottom],
    [b.left, b.top],
    [b.right, b.top],
  ][corner] || [b.left, b.top];
  state.drag = { type: "box", id, fixedX: fixed[0], fixedY: fixed[1], undo: true, moved: false };
  capturePointer(e);
  renderMarks();
  syncInspector();
  setStatus();
}

function startRotate(e, id) {
  state.selectedId = id;
  state.drag = { type: "rotate", id, undo: true };
  capturePointer(e);
  renderMarks();
  syncInspector();
}

function onPointerDown(e) {
  if (!state.doc) return;
  if (e.button === 1 || e.button === 2 || state.space) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  const pt = clientToPdf(e.clientX, e.clientY);
  if (state.tool === "line" || state.tool === "arrow" || state.tool === "run" || state.tool === "layout" || state.tool === "whitebox") {
    e.preventDefault();
    if (state.tool === "layout") layoutClick(pt, e.shiftKey);
    else if (state.tool === "whitebox") whiteboxClick(pt, e.shiftKey);
    else segmentClick(pt, state.tool);
    return;
  }
  const boxHandle = e.target.closest(".box-handle");
  if (boxHandle) {
    e.preventDefault();
    startBoxResize(e, boxHandle.dataset.id, Number(boxHandle.dataset.corner));
    return;
  }
  const end = e.target.closest(".wire-end");
  if (end) {
    e.preventDefault();
    startEnd(e, end.dataset.id, end.dataset.end);
    return;
  }
  const wire = e.target.closest(".wire");
  if (wire && wire.dataset.id) {
    e.preventDefault();
    startMove(e, wire.dataset.id);
    return;
  }
  const handle = e.target.closest(".handle");
  if (handle) {
    e.preventDefault();
    startRotate(e, handle.dataset.id);
    return;
  }
  const mark = e.target.closest(".mark");
  if (mark) {
    e.preventDefault();
    const hit = placement(mark.dataset.id);
    if (e.shiftKey && !e.altKey && isSwitchSymbol(hit) && !state.armedId && !state.tool) {
      const pdf = clientToPdf(e.clientX, e.clientY);
      state.drag = { type: "pick", id: hit.id, startX: pdf.x, startY: pdf.y };
      capturePointer(e);
      return;
    }
    startMove(e, mark.dataset.id);
    return;
  }
  if (state.calibStep === 1 || state.calibStep === 2) {
    calibClick(pt);
    return;
  }
  if (state.calibStep === 3) return;
  if (state.tool === "legend") {
    placeLegend(pt);
    return;
  }
  if (state.tool === "note") {
    placeNote(pt);
    return;
  }
  if (state.armedId) {
    placeAt(e.clientX, e.clientY, e.shiftKey);
    return;
  }
  if (state.selectedId || state.picked.size) {
    state.selectedId = null;
    state.picked = new Set();
    renderMarks();
    syncInspector();
    setStatus();
  }
}

function onPointerMove(e) {
  const target = e.target;
  const overSheet = target === viewport || (target instanceof Node && viewport.contains(target));
  if (state.doc && (overSheet || state.drag)) {
    const pt = clientToPdf(e.clientX, e.clientY);
    $("statusMid").textContent = `${(pt.x / 72).toFixed(2)}" from left · ${(pt.y / 72).toFixed(2)}" from top`;
    if (state.calibStep === 2 && state.calibDraft && !state.drag) {
      state.calibDraft.x2 = pt.x;
      state.calibDraft.y2 = pt.y;
      drawCalib();
    }
    const draft = state.tool === "line" ? state.lineDraft : state.tool === "arrow" ? state.arrowDraft : state.tool === "run" ? state.runDraft : null;
    if (draft && !state.drag) {
      const snapped = snapPoint(pt);
      draft.x2 = snapped.x;
      draft.y2 = snapped.y;
      renderWires();
    }
    if (state.layoutDraft && state.layoutDraft.page === state.pageIndex && !state.drag) {
      state.layoutDraft.x2 = pt.x;
      state.layoutDraft.y2 = pt.y;
      state.layoutDraft.square = e.shiftKey;
      renderWires();
    }
    if (state.whiteboxDraft && state.whiteboxDraft.page === state.pageIndex && !state.drag) {
      state.whiteboxDraft.x2 = pt.x;
      state.whiteboxDraft.y2 = pt.y;
      state.whiteboxDraft.square = e.shiftKey;
      renderWires();
    }
  }
  const drag = state.drag;
  if (!drag) return;
  if (drag.type === "pick") {
    const pdf = clientToPdf(e.clientX, e.clientY);
    if (Math.hypot(pdf.x - drag.startX, pdf.y - drag.startY) < 0.6) return;
    const id = drag.id;
    const start = { x: drag.startX, y: drag.startY };
    state.drag = null;
    startMove(e, id, start);
    return;
  }
  if (drag.type === "pan") {
    state.panX = drag.panX + (e.clientX - drag.x);
    state.panY = drag.panY + (e.clientY - drag.y);
    applyTransform();
    return;
  }
  if (drag.type === "end") {
    const p = placement(drag.id);
    if (!isSegment(p)) return;
    const pdf = snapPoint(clientToPdf(e.clientX, e.clientY), p.id);
    if (p.kind === "line" && !p.guide && pdf.anchorId && pdf.anchorId === (drag.end === "1" ? p.a2 : p.a1)) return;
    const nextX1 = drag.end === "1" ? pdf.x : p.x1;
    const nextY1 = drag.end === "1" ? pdf.y : p.y1;
    const nextX2 = drag.end === "1" ? p.x2 : pdf.x;
    const nextY2 = drag.end === "1" ? p.y2 : pdf.y;
    const minLen = p.kind === "arrow" ? 4 : p.kind === "run" ? 8 : 0;
    if (minLen && Math.hypot(nextX2 - nextX1, nextY2 - nextY1) < minLen) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    p.x1 = nextX1;
    p.y1 = nextY1;
    p.x2 = nextX2;
    p.y2 = nextY2;
    if (p.kind === "line" && !p.guide) {
      if (drag.end === "1") p.a1 = pdf.anchorId || null;
      else p.a2 = pdf.anchorId || null;
    }
    if ((p.kind === "line" && !p.guide) || p.kind === "run") {
      if (!p.circuit) {
        const inherited = circuitFromAnchor(pdf.anchorId);
        if (inherited) p.circuit = inherited;
      }
    }
    drag.moved = true;
    updateLine(p);
    return;
  }
  if (drag.type === "move") {
    const pdf = clientToPdf(e.clientX, e.clientY);
    const p = placement(drag.id);
    if (!p) return;
    const dx = pdf.x - drag.startX;
    const dy = pdf.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 0.6) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    drag.moved = true;
    if (drag.origins && drag.origins.length > 1 && !(isSegment(p) || isWhitebox(p))) {
      moveWithGroup(drag, dx, dy, e.shiftKey);
      return;
    }
    if (isSegment(p) || isWhitebox(p)) {
      p.x1 = drag.origin.x1 + dx;
      p.y1 = drag.origin.y1 + dy;
      p.x2 = drag.origin.x2 + dx;
      p.y2 = drag.origin.y2 + dy;
      if (p.kind === "line") {
        p.a1 = null;
        p.a2 = null;
      }
    } else {
      let x = drag.origin.x + dx;
      let y = drag.origin.y + dy;
      if (isSymbol(p)) {
        const snapped = snapPlacement({ x, y }, p.symbolId, p.freePlace, e.shiftKey);
        x = snapped.x;
        y = snapped.y;
      }
      p.x = x;
      p.y = y;
    }
    updateMark(p);
    return;
  }
  if (drag.type === "box") {
    const p = placement(drag.id);
    if (!isWhitebox(p)) return;
    const pdf = clientToPdf(e.clientX, e.clientY);
    let x = pdf.x;
    let y = pdf.y;
    if (e.shiftKey) {
      const corner = squareCorner(drag.fixedX, drag.fixedY, x, y);
      x = corner.x;
      y = corner.y;
    }
    if (Math.abs(x - drag.fixedX) < 8 || Math.abs(y - drag.fixedY) < 8) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    p.x1 = drag.fixedX;
    p.y1 = drag.fixedY;
    p.x2 = x;
    p.y2 = y;
    drag.moved = true;
    updateMark(p);
    const width = Math.abs(p.x2 - p.x1);
    const height = Math.abs(p.y2 - p.y1);
    $("sizeReadout").textContent = `${(width / 72).toFixed(2)}" × ${(height / 72).toFixed(2)}"`;
    return;
  }
  if (drag.type === "rotate") {
    const p = placement(drag.id);
    if (!isSymbol(p)) return;
    if (drag.undo) {
      pushUndo();
      drag.undo = false;
    }
    const c = pdfToClient(p.x, p.y);
    const ang = Math.atan2(e.clientY - c.y, e.clientX - c.x);
    let deg = (ang * 180) / Math.PI - 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    p.rotation = normRot(deg);
    updateMark(p);
  }
}

function onPointerUp() {
  const drag = state.drag;
  if (!drag) return;
  if (drag.type === "pick") {
    const id = drag.id;
    state.drag = null;
    viewport.classList.remove("panning");
    togglePick(placement(id));
    return;
  }
  if (drag.type === "move" && drag.alt && !drag.moved) {
    const p = placement(drag.id);
    if (p) {
      const shift = duplicateShift(p);
      if (isSegment(p) || isWhitebox(p)) {
        p.x1 += shift;
        p.y1 += shift;
        p.x2 += shift;
        p.y2 += shift;
      } else {
        p.x += shift;
        p.y += shift;
      }
      updateMark(p);
    }
  }
  if (drag.type === "move" && !drag.moved && !drag.alt) {
    const nextId = nextStackedId(drag.stack, drag.previousId);
    if (nextId) {
      state.selectedId = nextId;
      state.picked = new Set();
      state.drag = null;
      viewport.classList.remove("panning");
      renderMarks();
      syncInspector();
      setStatus();
      return;
    }
  }
  const changed = drag.moved || drag.type === "rotate";
  state.drag = null;
  viewport.classList.remove("panning");
  if (changed) scheduleSave();
}

function setStatus() {
  let left = "No plan open";
  if (state.doc) {
    if (state.calibStep === 1) left = "Calibrate: click the first point of a known length";
    else if (state.calibStep === 2) left = "Calibrate: click the second point";
    else if (state.calibStep === 3) left = "Enter that length, then Apply";
    else if (state.tool === "line" && state.lineDraft) left = "Dashed line: click the next point. Esc cancels this segment.";
    else if (state.tool === "line") left = "Dashed line: click the first point. Snap to a symbol to stay attached.";
    else if (state.tool === "layout" && state.layoutDraft) left = "Light layout: click the opposite corner. Shift makes a square.";
    else if (state.tool === "layout") left = "Light layout: click two corners to draw a construction rectangle.";
    else if (state.tool === "whitebox" && state.whiteboxDraft) left = "White box: click the opposite corner. Shift makes a square.";
    else if (state.tool === "whitebox") left = "White box: click two corners to cover the plan.";
    else if (state.tool === "arrow" && state.arrowDraft) left = "Arrow: click where it points. Esc cancels this arrow.";
    else if (state.tool === "arrow") left = "Arrow: click the first point, then where it points.";
    else if (state.tool === "run" && state.runDraft) left = "Run: click the other end. Esc cancels this run.";
    else if (state.tool === "run") {
      const sym = symbolsById[state.armedId];
      left = sym ? `${sym.name}: click one end, then the other.` : "Click one end, then the other.";
    }
    else if (state.tool === "note") left = "Note: click the sheet, then type. Esc puts the tool away.";
    else if (state.tool === "legend") left = "Click the sheet to drop the legend.";
    else if (state.armedId) {
      const sym = symbolsById[state.armedId];
      const name = sym ? sym.name : "symbol";
      const guides = state.placements.some((item) => item.kind === "line" && item.guide && item.page === state.pageIndex);
      left = guides
        ? `Placing ${name}. Click the plan. A click near a construction line snaps onto it.`
        : `Placing ${name}. Click the plan. Esc cancels.`;
    } else if (selected() && selected().kind === "line" && selected().guide) left = "Construction line. Place a symbol on it, or drag the line to move it.";
    else if (selected() && selected().kind === "line") left = selected().a1 || selected().a2
      ? "Blue ends stay attached. Drag an end off its symbol to disconnect it."
      : "Drag the line to move it. Drag an end to reshape it.";
    else if (selected() && selected().kind === "arrow") left = "Drag the arrow to move it. Drag an end to reshape it.";
    else if (selected() && selected().kind === "run") left = "Drag the run to move it. Drag an end to change its length.";
    else if (selected() && selected().kind === "note") left = "Edit the note in the side panel. Drag it on the sheet.";
    else if (selected() && selected().kind === "legend") left = "Drag the legend. The slider changes its width.";
    else if (selected() && selected().kind === "whitebox") left = "Drag the white box to move it. Drag a corner to resize it.";
    else if (selected() && selected().groupId && groupMembers(selected().groupId).length >= 2) left = "Drag moves every switch in this box. Each one still takes its own dashed line.";
    else if (pickedSwitches().length >= 2) left = "Group switches packs the blue-outlined switches into one box.";
    else if (selected()) left = "Drag to move. Drag the amber handle to rotate.";
    else left = "Pick a symbol, then click the plan.";
  }
  $("statusLeft").textContent = left;
  if (!state.doc) $("statusMid").textContent = "";
  if (!state.doc) {
    $("statusRight").textContent = "";
    setSaveStatus("", false);
    return;
  }
  const here = state.placements.filter((item) => item.page === state.pageIndex).length;
  const scale = state.calibration ? state.calibration.label : "scale not set";
  $("statusRight").textContent = `${here} on this sheet · ${state.placements.length} total · ${scale}`;
}
