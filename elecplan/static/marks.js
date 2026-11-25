"use strict";
// Drawing marks, wires, notes, legends, and white boxes on the sheet.

function spinGroup(svg) {
  for (const child of svg.children) {
    if (child.classList.contains("spin")) return child;
  }
  const spin = svg.ownerDocument.createElementNS(SVGNS, "g");
  spin.setAttribute("class", "spin");
  while (svg.firstChild) spin.appendChild(svg.firstChild);
  svg.appendChild(spin);
  return spin;
}

function setSpin(svg, rotation) {
  const spin = spinGroup(svg);
  const deg = Number(rotation) || 0;
  if (deg) spin.setAttribute("transform", `rotate(${deg} 50 50)`);
  else spin.removeAttribute("transform");
}

function paintSvg(symbolId, rotation, color) {
  const sym = symbolsById[symbolId];
  if (!sym) return null;
  const colored = sym.svg.replaceAll("#141414", color || sym.defaultColor || "#141414");
  const doc = new DOMParser().parseFromString(colored, "image/svg+xml");
  const node = doc.querySelector("svg");
  if (!node || doc.querySelector("parsererror")) return null;
  setSpin(node, rotation);
  return node;
}

function positionMark(el, p) {
  el.style.width = p.size + "px";
  el.style.height = p.size + "px";
  el.style.left = p.x - p.size / 2 + "px";
  el.style.top = p.y - p.size / 2 + "px";
}

function positionHandle(handle, p) {
  const rad = ((p.rotation + 90) * Math.PI) / 180;
  const dist = p.size / 2 + 18 / state.zoom;
  handle.style.left = p.size / 2 + Math.cos(rad) * dist + "px";
  handle.style.top = p.size / 2 + Math.sin(rad) * dist + "px";
  handle.style.transform = `translate(-50%, -50%) scale(${1 / state.zoom})`;
}

function markElement(p) {
  const el = document.createElement("div");
  const picked = state.picked.has(p.id) ? " picked" : "";
  el.className = "mark symbol" + (p.id === state.selectedId ? " selected" : "") + picked;
  el.dataset.id = p.id;
  positionMark(el, p);
  const glyph = document.createElement("div");
  glyph.className = "glyph";
  const svg = paintSvg(p.symbolId, p.rotation, p.color);
  if (svg) glyph.appendChild(document.importNode(svg, true));
  el.appendChild(glyph);
  const hit = document.createElement("div");
  hit.className = "hit";
  const hitPct = HIT_SCALE * 100;
  const hitInset = ((1 - HIT_SCALE) / 2) * 100;
  hit.style.width = hitPct + "%";
  hit.style.height = hitPct + "%";
  hit.style.left = hitInset + "%";
  hit.style.top = hitInset + "%";
  el.appendChild(hit);
  if (state.showCircuits && p.circuit) {
    const tag = document.createElement("div");
    tag.className = "circuit-tag";
    tag.textContent = p.circuit;
    el.appendChild(tag);
  }
  if (p.id === state.selectedId) {
    const handle = document.createElement("div");
    handle.className = "handle";
    handle.dataset.id = p.id;
    handle.title = "Drag to rotate. Shift snaps to 15°.";
    handle.textContent = "↻";
    positionHandle(handle, p);
    el.appendChild(handle);
  }
  return el;
}

function isSymbol(p) {
  return Boolean(p && (p.kind === "symbol" || (!p.kind && p.symbolId)));
}

function isSwitchSymbol(p) {
  if (!isSymbol(p)) return false;
  const sym = symbolsById[p.symbolId];
  return Boolean(sym && sym.category === "switches");
}

function symbolHitContains(p, x, y) {
  if (!isSymbol(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const half = (Number(p.size) || 0) * HIT_SCALE / 2;
  return Math.abs(x - p.x) <= half && Math.abs(y - p.y) <= half;
}

function symbolsAt(x, y) {
  const ids = [];
  for (const item of state.placements) {
    if (item.page !== state.pageIndex || !layerVisible(item)) continue;
    if (symbolHitContains(item, x, y)) ids.push(item.id);
  }
  return ids;
}

function nextStackedId(ids, previousId) {
  if (!ids || ids.length < 2) return null;
  const index = ids.indexOf(previousId);
  if (index < 0) return null;
  return ids[(index + 1) % ids.length];
}

function isSegment(p) {
  return Boolean(p && (p.kind === "line" || p.kind === "arrow" || p.kind === "run"));
}

function isWhitebox(p) {
  return Boolean(p && p.kind === "whitebox");
}

function symbolLayerName(sym) {
  if (!sym) return "Power";
  if (sym.category === "lighting" || sym.category === "switches") return "Lighting";
  if (sym.category === "lowvoltage" || sym.category === "safety") return "Low-volt";
  return "Power";
}

function defaultLayer(kind, symbolId, guide) {
  if (kind === "symbol" || kind === "run") return symbolLayerName(symbolsById[symbolId]);
  if (kind === "line") return guide ? "Lighting" : "Circuitry";
  return "Power";
}

function placeLayer(kind, symbolId, guide) {
  const visible = layerNames().filter((name) => !state.hiddenLayers.has(name));
  if (visible.length === 1) return visible[0];
  return defaultLayer(kind, symbolId, guide);
}

function normalizeLayer(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) return fallback;
  if ([...name].some((ch) => ch.charCodeAt(0) < 32)) return fallback;
  return name;
}

function cleanCircuit(value) {
  if (typeof value !== "string") return "";
  const name = value.replace(/\s+/g, " ").trim().slice(0, 24).trim();
  if (!name || [...name].some((ch) => ch.charCodeAt(0) < 32)) return "";
  return name;
}

function layerOf(p) {
  return (p && p.layer) || "Power";
}

function layerVisible(p) {
  return !state.hiddenLayers.has(layerOf(p));
}

function layerNames() {
  const names = [...LAYERS];
  for (const item of state.placements) {
    const name = (item.layer || "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function symbolSkipsSnap(symbolId, freePlace) {
  if (freePlace) return true;
  const sym = symbolsById[symbolId];
  if (!sym) return false;
  if (sym.id === "floor") return true;
  if (sym.category === "lighting" && sym.wall === false) return true;
  return false;
}

function boxBounds(p) {
  return {
    left: Math.min(p.x1, p.x2),
    top: Math.min(p.y1, p.y2),
    right: Math.max(p.x1, p.x2),
    bottom: Math.max(p.y1, p.y2),
  };
}

function isRunSymbol(sym) {
  return Boolean(sym && sym.place === "run" && sym.runLabel);
}

function runLabelOf(p) {
  const sym = p && symbolsById[p.symbolId];
  return (sym && sym.runLabel) || "";
}

function runGeometry(p) {
  const x1 = Number(p.x1);
  const y1 = Number(p.y1);
  const x2 = Number(p.x2);
  const y2 = Number(p.y2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const label = runLabelOf(p);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  if (length < 0.5) {
    return { length, bars: [], label, fontSize: 8, textX: midX, textY: midY + 11, angle: 0 };
  }
  const ux = dx / length;
  const uy = dy / length;
  let px = -uy;
  let py = ux;
  if (Math.abs(ux) >= Math.abs(uy)) {
    if (py < 0) {
      px = -px;
      py = -py;
    }
  } else if (px < 0) {
    px = -px;
    py = -py;
  }
  const bar = 5.5;
  const bars = [
    { x1: x1 - px * bar, y1: y1 - py * bar, x2: x1 + px * bar, y2: y1 + py * bar },
    { x1: x2 - px * bar, y1: y2 - py * bar, x2: x2 + px * bar, y2: y2 + py * bar },
  ];
  let fontSize = 8;
  const chars = Math.max(label.length, 1);
  const width = chars * fontSize * 0.62;
  if (width > length * 0.92) fontSize = Math.max(4.5, (length * 0.92) / (chars * 0.62));
  const offset = 2.4 + fontSize * 1.07;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle > 90 || angle <= -90) angle += 180;
  return {
    length,
    bars,
    label,
    fontSize,
    textX: midX + px * offset,
    textY: midY + py * offset,
    angle,
  };
}

function arrowParts(p) {
  const dx = p.x2 - p.x1;
  const dy = p.y2 - p.y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) {
    return { length, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, tipX: p.x2, tipY: p.y2 };
  }
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(11, length * 0.45);
  const wing = head * (4.2 / 11);
  const bx = p.x2 - ux * head;
  const by = p.y2 - uy * head;
  return {
    length,
    x1: p.x1,
    y1: p.y1,
    x2: bx,
    y2: by,
    tipX: p.x2,
    tipY: p.y2,
    leftX: bx - uy * wing,
    leftY: by + ux * wing,
    rightX: bx + uy * wing,
    rightY: by - ux * wing,
  };
}

function cleanNote(text) {
  let value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (value.length > 500) value = value.slice(0, 500);
  const lines = value.split("\n");
  if (lines.length > 16) value = lines.slice(0, 16).join("\n");
  return value;
}

function measureText(text, size) {
  if (!measureText.ctx) measureText.ctx = document.createElement("canvas").getContext("2d");
  measureText.ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureText.ctx.measureText(text).width;
}

function layoutLegend(symbols) {
  const nameSize = 9;
  const symSize = 26;
  const gap = 6;
  const slack = 10;
  const rowH = 36;
  const pad = 14;
  const gutter = 14;
  const header = 38;
  const title = { text: "SYMBOL LEGEND", x: pad, y: 26, size: 13, weight: "bold" };
  if (!symbols.length) return { width: 240, height: 72, items: [], labels: [title] };
  const nameW = slack + Math.max(...symbols.map((sym) => measureText(sym.name, nameSize)));
  const colW = symSize + gap + nameW;
  const count = symbols.length;
  let cols = count >= 6 && colW * 3 + gutter * 2 + pad * 2 <= 680 ? 3 : 2;
  cols = Math.max(1, Math.min(cols, count));
  const rows = Math.ceil(count / cols);
  const width = pad * 2 + cols * colW + (cols - 1) * gutter;
  const height = header + rows * rowH + pad;
  const items = [];
  const labels = [title];
  symbols.forEach((sym, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = pad + col * (colW + gutter) + symSize / 2;
    const cy = header + row * rowH + rowH / 2;
    items.push({
      id: sym.id,
      name: sym.name,
      x: Math.round(cx * 100) / 100,
      y: Math.round(cy * 100) / 100,
      size: symSize,
      color: sym.defaultColor || "#141414",
    });
    labels.push({
      text: sym.name,
      x: Math.round((cx + symSize / 2 + gap) * 100) / 100,
      y: Math.round((cy + nameSize * 0.35) * 100) / 100,
      size: nameSize,
      weight: "regular",
    });
  });
  return {
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
    items,
    labels,
  };
}

function usedLegendSymbols() {
  const used = new Set();
  for (const item of state.placements) {
    if (!layerVisible(item)) continue;
    if (!(isSymbol(item) || item.kind === "run") || !item.symbolId) continue;
    if (!symbolsById[item.symbolId]) continue;
    used.add(item.symbolId);
  }
  return library.symbols.filter((sym) => used.has(sym.id));
}

function visibleLegendLayout() {
  if (!library || !Array.isArray(library.symbols)) return null;
  return layoutLegend(usedLegendSymbols());
}

function legendBox(width) {
  const lay = visibleLegendLayout();
  if (!lay || !lay.width) return { width: width || 360, height: 240, scale: 1 };
  const scale = (width || lay.width) / lay.width;
  return { width: lay.width * scale, height: lay.height * scale, scale };
}

function legendElement(p) {
  const lay = visibleLegendLayout();
  const el = document.createElement("div");
  el.className = "mark legend" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  const box = legendBox(p.width);
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  const glyph = document.createElement("div");
  glyph.className = "glyph";
  if (lay) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "legend-svg");
    svg.setAttribute("viewBox", `0 0 ${lay.width} ${lay.height}`);
    const border = document.createElementNS(SVGNS, "rect");
    border.setAttribute("x", "0.6");
    border.setAttribute("y", "0.6");
    border.setAttribute("width", String(lay.width - 1.2));
    border.setAttribute("height", String(lay.height - 1.2));
    border.setAttribute("fill", "#ffffff");
    border.setAttribute("stroke", "#383838");
    border.setAttribute("stroke-width", "1");
    svg.appendChild(border);
    for (const entry of lay.items || []) {
      const node = paintSvg(entry.id, 0, entry.color);
      if (!node) continue;
      const mark = document.importNode(node, true);
      mark.setAttribute("x", String(entry.x - entry.size / 2));
      mark.setAttribute("y", String(entry.y - entry.size / 2));
      mark.setAttribute("width", String(entry.size));
      mark.setAttribute("height", String(entry.size));
      svg.appendChild(mark);
    }
    for (const label of lay.labels || []) {
      const text = document.createElementNS(SVGNS, "text");
      text.setAttribute("x", String(label.x));
      text.setAttribute("y", String(label.y));
      text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
      text.setAttribute("font-size", String(label.size));
      text.setAttribute("font-weight", label.weight === "bold" ? "700" : "400");
      text.setAttribute("fill", "#141414");
      text.textContent = label.text;
      svg.appendChild(text);
    }
    glyph.appendChild(svg);
  }
  el.appendChild(glyph);
  return el;
}

function wireMetrics() {
  return {
    hit: Math.max(10, 14 / state.zoom),
    handle: 5.5 / state.zoom,
  };
}

function wireLayer(id) {
  let svg = document.getElementById(id);
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.id = id;
    marksLayer.appendChild(svg);
  }
  const page = currentPage();
  if (page) {
    svg.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
    svg.setAttribute("width", String(page.width));
    svg.setAttribute("height", String(page.height));
  }
  return svg;
}

const HOP_RADIUS = 7;

function isHoppable(p) {
  if (!p) return false;
  if (p.kind === "run") return true;
  return p.kind === "line" && p.guide !== true;
}

function visibleSegments() {
  const items = [];
  for (const item of state.placements) {
    if (!isSegment(item) || item.page !== state.pageIndex || !layerVisible(item)) continue;
    items.push(item);
  }
  if (state.lineDraft && state.lineDraft.page === state.pageIndex) items.push(state.lineDraft);
  if (state.runDraft && state.runDraft.page === state.pageIndex) items.push(state.runDraft);
  return items;
}

function crossingDistances(items) {
  /* Keep this in step with crossing_hops in export.py. The later segment hops. */
  const indexes = [];
  items.forEach((item, index) => {
    if (isHoppable(item)) indexes.push(index);
  });
  const found = new Map();
  for (const index of indexes) found.set(items[index], []);
  for (let pos = 0; pos < indexes.length; pos += 1) {
    const first = items[indexes[pos]];
    const ax1 = Number(first.x1);
    const ay1 = Number(first.y1);
    const ax2 = Number(first.x2);
    const ay2 = Number(first.y2);
    const arx = ax2 - ax1;
    const ary = ay2 - ay1;
    const alen = Math.hypot(arx, ary);
    if (alen < 8) continue;
    for (let next = pos + 1; next < indexes.length; next += 1) {
      const second = items[indexes[next]];
      if (Number(first.page) !== Number(second.page)) continue;
      const bx1 = Number(second.x1);
      const by1 = Number(second.y1);
      const bx2 = Number(second.x2);
      const by2 = Number(second.y2);
      const brx = bx2 - bx1;
      const bry = by2 - by1;
      const blen = Math.hypot(brx, bry);
      if (blen < 8) continue;
      const den = arx * bry - ary * brx;
      if (Math.abs(den) / (alen * blen) < 0.26) continue;
      const qpx = bx1 - ax1;
      const qpy = by1 - ay1;
      const t = (qpx * bry - qpy * brx) / den;
      const u = (qpx * ary - qpy * arx) / den;
      if (t > 0.08 && t < 0.92 && u > 0.08 && u < 0.92) found.get(second).push(u * blen);
    }
  }
  return found;
}

function strokeParts(x1, y1, x2, y2, distances) {
  /* Semicircle hops. Same radius and cubic as _stroke_segment in export.py. */
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 1) return null;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const px = -uy;
  const py = ux;
  const radius = Math.min(HOP_RADIUS, length * 0.18);
  const cuts = [];
  const sorted = (distances || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const dist of sorted) {
    if (dist - radius < 6 || dist + radius > length - 6) continue;
    if (cuts.length && dist - radius < cuts[cuts.length - 1][1] + 1) continue;
    cuts.push([dist - radius, dist + radius]);
  }
  const bow = 0.5522847498;
  let cx = x1;
  let cy = y1;
  let shaft = `M ${cx} ${cy}`;
  const arcs = [];
  for (const [start, stop] of cuts) {
    const ax = x1 + ux * start;
    const ay = y1 + uy * start;
    const bx = x1 + ux * stop;
    const by = y1 + uy * stop;
    const mid = (start + stop) / 2;
    const topx = x1 + ux * mid + px * radius;
    const topy = y1 + uy * mid + py * radius;
    shaft += ` L ${ax} ${ay} M ${bx} ${by}`;
    arcs.push(
      `M ${ax} ${ay} C ${ax + px * bow * radius} ${ay + py * bow * radius}, ${topx - ux * bow * radius} ${topy - uy * bow * radius}, ${topx} ${topy} C ${topx + ux * bow * radius} ${topy + uy * bow * radius}, ${bx + px * bow * radius} ${by + py * bow * radius}, ${bx} ${by}`,
    );
    cx = bx;
    cy = by;
  }
  shaft += ` L ${x2} ${y2}`;
  return { shaft, arcs };
}

function hopPathParts(p, distances) {
  return strokeParts(Number(p.x1), Number(p.y1), Number(p.x2), Number(p.y2), distances);
}

function addWirePath(parent, d, className, color, width, dash) {
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("class", className);
  path.setAttribute("d", d);
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", String(width));
  path.setAttribute("fill", "none");
  if (dash) path.setAttribute("stroke-dasharray", dash === true ? "8 6" : String(dash));
  path.setAttribute("stroke-linecap", dash ? "butt" : "round");
  path.setAttribute("pointer-events", "none");
  parent.appendChild(path);
  return path;
}

function addHoppedStroke(parent, p, className, color, width, dash, distances) {
  const parts = hopPathParts(p, distances);
  if (!parts) return false;
  addWirePath(parent, parts.shaft, className, color, width, dash);
  for (const arc of parts.arcs) addWirePath(parent, arc, className, color, width, false);
  return true;
}

function addWireLine(parent, p, className, color, width, events, dashed) {
  const line = document.createElementNS(SVGNS, "line");
  line.setAttribute("class", className);
  line.setAttribute("x1", p.x1);
  line.setAttribute("y1", p.y1);
  line.setAttribute("x2", p.x2);
  line.setAttribute("y2", p.y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(width));
  if (dashed) line.setAttribute("stroke-dasharray", dashed === true ? "8 6" : String(dashed));
  line.setAttribute("stroke-linecap", "butt");
  line.setAttribute("fill", "none");
  if (events) line.setAttribute("pointer-events", events);
  parent.appendChild(line);
  return line;
}

function addArrowHead(parent, p, color, events) {
  const head = arrowParts(p);
  if (!head.leftX && head.leftX !== 0) return;
  if (head.length < 0.5) return;
  const poly = document.createElementNS(SVGNS, "polygon");
  poly.setAttribute("class", "arrow-head");
  poly.setAttribute("points", `${head.tipX},${head.tipY} ${head.leftX},${head.leftY} ${head.rightX},${head.rightY}`);
  poly.setAttribute("fill", color);
  poly.setAttribute("stroke", color);
  poly.setAttribute("stroke-width", "0.6");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("pointer-events", events || "all");
  parent.appendChild(poly);
}

function addRunLabel(parent, geo, color, events) {
  if (!geo.label) return;
  const text = document.createElementNS(SVGNS, "text");
  text.setAttribute("class", "run-label");
  text.setAttribute("x", "0");
  text.setAttribute("y", "0");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("transform", `translate(${geo.textX} ${geo.textY}) rotate(${geo.angle})`);
  text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
  text.setAttribute("font-size", String(geo.fontSize));
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", color);
  text.setAttribute("pointer-events", events);
  text.textContent = geo.label;
  parent.appendChild(text);
}

function wireGroup(p, draft, distances) {
  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", draft ? "wire wire-draft" : "wire");
  if (!draft) g.dataset.id = p.id;
  const metrics = wireMetrics();
  const color = p.color || state.ink || "#141414";
  const hops = distances || [];
  if (p.kind === "run") {
    const geo = runGeometry(p);
    if (!draft && p.id === state.selectedId) {
      if (!addHoppedStroke(g, p, "wire-halo", "#e2a23a", 3.4, false, hops)) {
        addWireLine(g, p, "wire-halo", "#e2a23a", 3.4, "none", false);
      }
      for (const bar of geo.bars) addWireLine(g, bar, "wire-halo", "#e2a23a", 3.4, "none", false);
    }
    if (!addHoppedStroke(g, p, "wire-ink", color, 1.35, false, hops)) {
      addWireLine(g, p, "wire-ink", color, 1.35, "none", false);
    }
    for (const bar of geo.bars) addWireLine(g, bar, "run-bar", color, 1.35, draft ? "none" : "stroke", false);
    addRunLabel(g, geo, color, draft ? "none" : "all");
    if (!draft && state.showCircuits && p.circuit) addCircuitTag(g, p);
    if (!draft) {
      const hit = addWireLine(g, p, "wire-hit", "#141414", metrics.hit, "stroke", false);
      hit.setAttribute("stroke-opacity", "0.01");
    }
    return g;
  }
  const arrow = p.kind === "arrow";
  const shaft = arrow ? arrowParts(p) : p;
  const dash = arrow ? false : (p.guide ? "2.5 2.5" : true);
  const inkWidth = p.guide ? 0.9 : 1.35;
  const hopped = !arrow && !p.guide;
  if (!draft && p.id === state.selectedId) {
    if (!(hopped && addHoppedStroke(g, p, "wire-halo", "#e2a23a", 3.4, false, hops))) {
      addWireLine(g, p, "wire-halo", "#e2a23a", 3.4, "none", dash);
    }
  }
  if (!(hopped && addHoppedStroke(g, p, "wire-ink", color, inkWidth, true, hops))) {
    addWireLine(g, shaft, "wire-ink", color, inkWidth, "none", dash);
  }
  if (arrow) addArrowHead(g, p, color, draft ? "none" : "all");
  if (!draft && state.showCircuits && p.circuit && !p.guide) addCircuitTag(g, p);
  if (!draft) {
    const hit = addWireLine(g, p, "wire-hit", "#141414", metrics.hit, "stroke", false);
    hit.setAttribute("stroke-opacity", "0.01");
  }
  return g;
}

function addCircuitTag(parent, p) {
  const text = document.createElementNS(SVGNS, "text");
  text.setAttribute("class", "wire-circuit");
  text.setAttribute("x", String((Number(p.x1) + Number(p.x2)) / 2));
  text.setAttribute("y", String(Math.min(Number(p.y1), Number(p.y2)) - 3));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
  text.setAttribute("font-size", "7");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", "#141414");
  text.setAttribute("stroke", "#ffffff");
  text.setAttribute("stroke-width", "2");
  text.setAttribute("paint-order", "stroke");
  text.setAttribute("pointer-events", "none");
  text.textContent = p.circuit;
  parent.appendChild(text);
}

function handleGroup(p) {
  const g = document.createElementNS(SVGNS, "g");
  g.dataset.ends = p.id;
  const radius = wireMetrics().handle;
  for (const [end, x, y] of [
    ["1", p.x1, p.y1],
    ["2", p.x2, p.y2],
  ]) {
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "wire-end");
    dot.dataset.id = p.id;
    dot.dataset.end = end;
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(radius));
    const anchored = p.kind === "line" && ((end === "1" && p.a1) || (end === "2" && p.a2));
    dot.setAttribute("fill", anchored ? "#1d4e89" : "#e2a23a");
    dot.setAttribute("stroke", "#2a1c06");
    dot.setAttribute("stroke-width", String(1 / state.zoom));
    g.appendChild(dot);
  }
  return g;
}

function renderWires() {
  if (!marksLayer) return;
  const wires = wireLayer("wires");
  const handles = wireLayer("wireHandles");
  wires.replaceChildren();
  handles.replaceChildren();
  if (!currentPage()) return;
  const hops = crossingDistances(visibleSegments());
  for (const p of state.placements) {
    if (!isSegment(p) || p.page !== state.pageIndex || !layerVisible(p)) continue;
    wires.appendChild(wireGroup(p, false, hops.get(p)));
    if (p.id === state.selectedId) handles.appendChild(handleGroup(p));
  }
  const selectedBox = selected();
  if (isWhitebox(selectedBox) && selectedBox.page === state.pageIndex && layerVisible(selectedBox)) {
    handles.appendChild(boxHandleGroup(selectedBox));
  }
  if (state.lineDraft && state.lineDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.lineDraft, true, hops.get(state.lineDraft)));
  }
  if (state.arrowDraft && state.arrowDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.arrowDraft, true));
  }
  if (state.runDraft && state.runDraft.page === state.pageIndex) {
    wires.appendChild(wireGroup(state.runDraft, true, hops.get(state.runDraft)));
  }
  if (state.layoutDraft && state.layoutDraft.page === state.pageIndex) {
    addLayoutDraft(wires);
  }
  if (state.whiteboxDraft && state.whiteboxDraft.page === state.pageIndex) {
    addWhiteboxDraft(wires);
  }
}

function refreshWireChrome() {
  if (!marksLayer) return;
  const metrics = wireMetrics();
  for (const line of marksLayer.querySelectorAll(".wire-hit")) {
    line.setAttribute("stroke-width", String(metrics.hit));
  }
  for (const dot of marksLayer.querySelectorAll(".wire-end, .box-handle")) {
    dot.setAttribute("r", String(metrics.handle));
    dot.setAttribute("stroke-width", String(1 / state.zoom));
  }
}

function renderMarks() {
  marksLayer.innerHTML = "";
  if (!state.doc) {
    renderCounts();
    return;
  }
  for (const p of state.placements) {
    if (p.page !== state.pageIndex || isSegment(p) || !layerVisible(p)) continue;
    if (p.kind === "whitebox") marksLayer.appendChild(whiteboxElement(p));
    else if (p.kind === "legend") marksLayer.appendChild(legendElement(p));
    else if (p.kind === "note") marksLayer.appendChild(noteElement(p));
    else marksLayer.appendChild(markElement(p));
  }
  renderWires();
  paintGangBoxes();
  drawCalib();
  renderCounts();
}

function updateLine(p) {
  if (isHoppable(p)) {
    renderWires();
    return;
  }
  const g = marksLayer.querySelector(`.wire[data-id="${CSS.escape(p.id)}"]`);
  if (!g) {
    renderWires();
    return;
  }
  const arrow = p.kind === "arrow";
  const shaft = arrow ? arrowParts(p) : p;
  const color = p.color || "#141414";
  for (const line of g.querySelectorAll("line")) {
    const useShaft = arrow && line.classList.contains("wire-ink");
    const src = useShaft ? shaft : p;
    line.setAttribute("x1", src.x1);
    line.setAttribute("y1", src.y1);
    line.setAttribute("x2", src.x2);
    line.setAttribute("y2", src.y2);
  }
  const ink = g.querySelector(".wire-ink");
  if (ink) ink.setAttribute("stroke", color);
  const head = g.querySelector(".arrow-head");
  if (head && arrow && shaft.leftX !== undefined) {
    head.setAttribute("points", `${shaft.tipX},${shaft.tipY} ${shaft.leftX},${shaft.leftY} ${shaft.rightX},${shaft.rightY}`);
    head.setAttribute("fill", color);
    head.setAttribute("stroke", color);
  }
  const ends = marksLayer.querySelector(`[data-ends="${CSS.escape(p.id)}"]`);
  if (ends) {
    const first = ends.querySelector('[data-end="1"]');
    const second = ends.querySelector('[data-end="2"]');
    if (first) {
      first.setAttribute("cx", p.x1);
      first.setAttribute("cy", p.y1);
      if (p.kind === "line") first.setAttribute("fill", p.a1 ? "#1d4e89" : "#e2a23a");
    }
    if (second) {
      second.setAttribute("cx", p.x2);
      second.setAttribute("cy", p.y2);
      if (p.kind === "line") second.setAttribute("fill", p.a2 ? "#1d4e89" : "#e2a23a");
    }
  }
}

function updateLegend(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el) {
    renderMarks();
    return;
  }
  const box = legendBox(p.width);
  el.style.width = box.width + "px";
  el.style.height = box.height + "px";
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
}

function noteElement(p) {
  const el = document.createElement("div");
  el.className = "mark note" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.style.fontSize = p.size + "px";
  el.style.color = p.color || "#141414";
  const text = document.createElement("div");
  text.className = "note-text";
  const body = p.text || "";
  if (body.trim()) text.textContent = body;
  else {
    text.textContent = "Note";
    text.classList.add("placeholder");
  }
  el.appendChild(text);
  return el;
}

function updateNote(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el || !el.classList.contains("note")) {
    renderMarks();
    return;
  }
  el.style.left = p.x + "px";
  el.style.top = p.y + "px";
  el.style.fontSize = p.size + "px";
  el.style.color = p.color || "#141414";
  const text = el.querySelector(".note-text");
  if (!text) {
    renderMarks();
    return;
  }
  const body = p.text || "";
  if (body.trim()) {
    text.textContent = body;
    text.classList.remove("placeholder");
  } else {
    text.textContent = "Note";
    text.classList.add("placeholder");
  }
}

function whiteboxElement(p) {
  const b = boxBounds(p);
  const el = document.createElement("div");
  el.className = "mark whitebox" + (p.id === state.selectedId ? " selected" : "");
  el.dataset.id = p.id;
  el.style.left = b.left + "px";
  el.style.top = b.top + "px";
  el.style.width = b.right - b.left + "px";
  el.style.height = b.bottom - b.top + "px";
  return el;
}

function boxHandleGroup(p) {
  const g = document.createElementNS(SVGNS, "g");
  g.dataset.box = p.id;
  const b = boxBounds(p);
  const radius = wireMetrics().handle;
  const corners = [
    [b.left, b.top],
    [b.right, b.top],
    [b.right, b.bottom],
    [b.left, b.bottom],
  ];
  corners.forEach(([x, y], index) => {
    const dot = document.createElementNS(SVGNS, "circle");
    dot.setAttribute("class", "box-handle");
    dot.dataset.id = p.id;
    dot.dataset.corner = String(index);
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(radius));
    dot.setAttribute("fill", "#e2a23a");
    dot.setAttribute("stroke", "#2a1c06");
    dot.setAttribute("stroke-width", String(1 / state.zoom));
    g.appendChild(dot);
  });
  return g;
}

function updateWhitebox(p) {
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el || !el.classList.contains("whitebox")) {
    renderMarks();
    return;
  }
  const b = boxBounds(p);
  el.style.left = b.left + "px";
  el.style.top = b.top + "px";
  el.style.width = b.right - b.left + "px";
  el.style.height = b.bottom - b.top + "px";
}

function positionBoxHandles(p) {
  const g = marksLayer.querySelector(`[data-box="${CSS.escape(p.id)}"]`);
  if (!g) {
    renderWires();
    return;
  }
  const b = boxBounds(p);
  const corners = [
    [b.left, b.top],
    [b.right, b.top],
    [b.right, b.bottom],
    [b.left, b.bottom],
  ];
  g.querySelectorAll(".box-handle").forEach((dot, index) => {
    dot.setAttribute("cx", corners[index][0]);
    dot.setAttribute("cy", corners[index][1]);
  });
}

function updateMark(p) {
  if (isWhitebox(p)) {
    updateWhitebox(p);
    positionBoxHandles(p);
    return;
  }
  if (isSegment(p)) {
    updateLine(p);
    return;
  }
  if (followAnchors(p)) renderWires();
  if (p.groupId) paintGangBoxes();
  if (p.kind === "legend") {
    updateLegend(p);
    return;
  }
  if (p.kind === "note") {
    updateNote(p);
    return;
  }
  const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(p.id)}"]`);
  if (!el) {
    renderMarks();
    return;
  }
  positionMark(el, p);
  const svg = el.querySelector("svg");
  if (svg) setSpin(svg, p.rotation);
  const handle = el.querySelector(".handle");
  if (handle) positionHandle(handle, p);
  const rotInput = $("rotInput");
  if (rotInput && document.activeElement !== rotInput && p.id === state.selectedId) {
    rotInput.value = String(Math.round(p.rotation));
  }
}

function drawCalib() {
  const page = currentPage();
  calibLayer.innerHTML = "";
  if (!page) return;
  calibLayer.setAttribute("viewBox", `0 0 ${page.width} ${page.height}`);
  calibLayer.setAttribute("width", String(page.width));
  calibLayer.setAttribute("height", String(page.height));
  if (state.calibration && state.calibration.page === state.pageIndex) {
    addMeasure(state.calibration, false);
  }
  if (state.calibDraft && state.calibDraft.page === state.pageIndex && state.calibStep) {
    addMeasure(state.calibDraft, true);
  }
}

function addMeasure(m, active) {
  const ns = "http://www.w3.org/2000/svg";
  const color = active ? "#e2a23a" : "#1d4e89";
  const line = document.createElementNS(ns, "line");
  line.setAttribute("x1", m.x1);
  line.setAttribute("y1", m.y1);
  line.setAttribute("x2", m.x2);
  line.setAttribute("y2", m.y2);
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", String(1.6 / state.zoom));
  line.setAttribute("stroke-linecap", "round");
  calibLayer.appendChild(line);
  for (const [x, y] of [
    [m.x1, m.y1],
    [m.x2, m.y2],
  ]) {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", String(4.5 / state.zoom));
    dot.setAttribute("fill", color);
    calibLayer.appendChild(dot);
  }
}
