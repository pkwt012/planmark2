"use strict";
// Opening and exporting plans, keys, panel layout, and start-up.

function askSavedSheets(added) {
  const dialog = $("sheetsDialog");
  const many = added !== 1;
  $("sheetsText").textContent =
    `Last time, ${added} sheet${many ? "s were" : " was"} added to this plan ` +
    `(more pages, a legend, counts, or a schedule). Bring ${many ? "them" : "it"} back with ${many ? "their" : "its"} marks? ` +
    `If you open without ${many ? "them" : "it"}, marks on ${many ? "those sheets" : "that sheet"} are dropped.`;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue !== "drop"), { once: true });
    dialog.returnValue = "";
    dialog.showModal();
  });
}

// The plan keeps its id when sheets are added, and the server keeps a copy
// of the plan with those sheets. Ask before any marks are put back, so the
// marks on the added sheets are not dropped.
async function settleSavedSheets(info) {
  const added = info.savedSheets ? Number(info.savedSheets.added) : 0;
  if (!(added > 0)) return info;
  const keep = await askSavedSheets(added);
  if (!keep) {
    await fetch("/api/sheets/discard", { method: "POST" }).catch(() => null);
    return info;
  }
  const res = await fetch("/api/sheets/restore", { method: "POST" });
  if (!res.ok) {
    toast(await readError(res));
    return info;
  }
  const restored = await res.json();
  if (info.project) restored.project = info.project;
  if (info.revisionWarning) restored.revisionWarning = info.revisionWarning;
  return restored;
}

function sheetsAddedToast(info, message) {
  toast(info.sheetsWarning || message);
}

async function openPdfBytes(buf, filename, { append = false } = {}) {
  setBusy(true, append ? "Adding sheets…" : "Opening plan…");
  try {
    const url = append ? "/api/append" : "/api/open?name=" + encodeURIComponent(filename);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: buf,
    });
    if (!res.ok) throw new Error(await readError(res));
    let info = await res.json();
    if (append) {
      const had = state.doc ? state.doc.pageCount : 0;
      state.doc = info;
      updatePager();
      scheduleSave();
      sheetsAddedToast(info, `Added ${info.added || info.pageCount - had} sheet${info.added === 1 ? "" : "s"}.`);
      return;
    }
    info = await settleSavedSheets(info);
    const previousMarks = state.placements.length;
    state.doc = info;
    state.placements = [];
    state.selectedId = null;
    state.armedId = null;
    state.tool = null;
    state.lineDraft = null;
    state.arrowDraft = null;
    state.runDraft = null;
    state.layoutDraft = null;
    state.whiteboxDraft = null;
    state.hiddenLayers = new Set();
    state.showCircuits = false;
    state.calibration = null;
    state.calibStep = 0;
    state.calibDraft = null;
    state.undo = [];
    state.redo = [];
    state.picked = new Set();
    state.pendingRecovery = null;
    state.browserSavedAt = "";
    const recoverBar = $("recoverBar");
    if (recoverBar) recoverBar.hidden = true;
    setSaveStatus("", false);
    state.imageKey = "";
    state.imageToken += 1;
    showWorkspace();
    showPage(0, { fit: true });
    renderPalette();
    const pending = state.pendingProject;
    state.pendingProject = null;
    let appliedStamp = "";
    let appliedPlacements = null;
    let skipOffer = false;
    if (pending) {
      skipOffer = true;
      applyProject(pending);
      toast("Loaded the marks file onto this plan.");
    } else if (info.project) {
      appliedStamp = info.project.savedAt || "";
      appliedPlacements = info.project.placements || [];
      applyProject(info.project, { quiet: true });
      toast("Opened a revision file. The marks are editable.");
    } else if (info.revisionWarning) {
      toast(info.revisionWarning);
    } else {
      const raw = localStorage.getItem("planmarks:v1:" + info.id);
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          const hasMarks = (saved.placements || []).length || saved.calibration;
          appliedStamp = saved.savedAt || "";
          appliedPlacements = saved.placements || [];
          if (hasMarks) {
            applyProject(saved, { quiet: true });
            toast("Restored marks saved in this browser for this PDF.");
          }
        } catch (_err) {
          /* ignore a damaged autosave */
        }
      } else if (previousMarks) {
        toast("Opened a new plan. Marks on the previous file stay in this browser.");
      }
    }
    syncInspector();
    setStatus();
    if (!skipOffer) await offerRecovery(info.id, appliedStamp, appliedPlacements);
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function openFile(file, { append = false } = {}) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openPdfBytes(buf, file.name, { append });
}

async function addLegend() {
  if (!state.doc) return;
  const symbols = usedLegendSymbols();
  if (!symbols.length) {
    toast("Place a symbol before adding a legend.");
    return;
  }
  setBusy(true, "Adding legend…");
  try {
    const res = await fetch("/api/legend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbolIds: symbols.map((sym) => sym.id),
        names: symbols.map((sym) => sym.name),
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const info = await res.json();
    state.doc = info;
    const start = Math.max(0, info.pageCount - (info.added || 1));
    showPage(start, { fit: true });
    scheduleSave();
    sheetsAddedToast(info, "Added a legend sheet.");
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
}

async function openSample() {
  setBusy(true, "Opening sample…");
  try {
    const res = await fetch("/api/sample.pdf");
    if (!res.ok) throw new Error(await readError(res));
    const buf = await res.arrayBuffer();
    setBusy(false);
    await openPdfBytes(buf, "sample-plan.pdf");
  } catch (err) {
    setBusy(false);
    toast(err.message);
  }
}

async function saveProject() {
  if (!state.doc) return;
  try {
    localStorage.setItem("planmarks:manualAt:" + state.doc.id, String(Date.now()));
  } catch (_err) {
    /* private mode */
  }
  await writeRecovery(false);
  const base = state.doc.filename.replace(/\.pdf$/i, "") || "plan";
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: "application/json" });
  download(blob, base + "-marks.json");
}

function loadProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyProject(JSON.parse(String(reader.result)));
    } catch (_err) {
      toast("Could not read that project file.");
    }
  };
  reader.readAsText(file);
}

async function exportPdf(revise) {
  if (!state.doc) return;
  const reviseBtn = $("reviseBtn");
  const finalBtn = $("exportBtn");
  reviseBtn.disabled = true;
  finalBtn.disabled = true;
  (revise ? reviseBtn : finalBtn).textContent = "Exporting…";
  try {
    await writeRecovery(false);
    const body = {
      placements: state.exportAllLayers ? state.placements : state.placements.filter(layerVisible),
      ocg: state.exportAllLayers,
      hiddenLayers: [...state.hiddenLayers],
      showCircuits: state.showCircuits,
    };
    if (revise) {
      body.revise = true;
      body.project = projectData();
    }
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res));
    const blob = await res.blob();
    let name = state.doc.filename.replace(/\.pdf$/i, "") + (revise ? "-revise.pdf" : "-marked.pdf");
    const disp = res.headers.get("Content-Disposition") || "";
    const star = /filename\*=UTF-8''([^;]+)/.exec(disp);
    if (star) name = decodeURIComponent(star[1]);
    download(blob, name);
    if (!state.placements.length) toast("No symbols yet. Exported the plan unchanged.");
  } catch (err) {
    toast(err.message);
  } finally {
    reviseBtn.disabled = !state.doc;
    finalBtn.disabled = !state.doc;
    reviseBtn.textContent = "Export to revise";
    finalBtn.textContent = "Export final";
  }
}

function isTyping() {
  const tag = document.activeElement && document.activeElement.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function onKeyDown(e) {
  if (e.key === "Escape" && isTyping()) {
    document.activeElement.blur();
    return;
  }
  if (isTyping()) return;
  const meta = e.ctrlKey || e.metaKey;
  if (e.code === "Space") {
    state.space = true;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (state.calibStep) cancelCalib();
    else if (state.lineDraft || state.arrowDraft || state.runDraft || state.layoutDraft || state.whiteboxDraft) {
      state.lineDraft = null;
      state.arrowDraft = null;
      state.runDraft = null;
      state.layoutDraft = null;
      state.whiteboxDraft = null;
      renderWires();
      syncInspector();
      setStatus();
    } else if (state.tool) setTool(state.tool);
    else if (state.armedId) toggleArm(state.armedId);
    else if (state.selectedId || state.picked.size) {
      state.selectedId = null;
      state.picked = new Set();
      renderMarks();
      syncInspector();
      setStatus();
    }
    return;
  }
  if (meta && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
    return;
  }
  if (meta && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (meta && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject();
    return;
  }
  if (meta && e.key.toLowerCase() === "o") {
    e.preventDefault();
    $("filePdf").click();
    return;
  }
  if (meta && e.key === "0") {
    e.preventDefault();
    fitView();
    return;
  }
  if (meta && e.key === "1") {
    e.preventDefault();
    actualSize();
    return;
  }
  if (meta && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1.15);
    return;
  }
  if (meta && e.key === "-") {
    e.preventDefault();
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1 / 1.15);
    return;
  }
  if (e.key === "?" || e.key === "F1") {
    e.preventDefault();
    $("help").showModal();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === "PageUp") {
    goToPage(state.pageIndex - 1);
    return;
  }
  if (e.key === "PageDown") {
    goToPage(state.pageIndex + 1);
    return;
  }
  if (!meta && (e.key === "r" || e.key === "R")) {
    const p = selected();
    if (!isSymbol(p)) return;
    if (!e.repeat) pushUndo();
    p.rotation = normRot(p.rotation + (e.shiftKey ? -15 : 15));
    updateMark(p);
    scheduleSave();
    return;
  }
  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!meta && nudge[e.key]) {
    const p = selected();
    if (!p) return;
    e.preventDefault();
    if (!e.repeat) pushUndo();
    const step = e.shiftKey ? 8 : 1;
    const dx = nudge[e.key][0] * step;
    const dy = nudge[e.key][1] * step;
    const mates = p.groupId && isSwitchSymbol(p) ? groupMembers(p.groupId) : [p];
    if (mates.length > 1) {
      let wired = false;
      for (const mate of mates) {
        mate.x += dx;
        mate.y += dy;
        if (followAnchors(mate)) wired = true;
      }
      if (wired) renderWires();
      for (const mate of mates) {
        const el = marksLayer.querySelector(`.mark[data-id="${CSS.escape(mate.id)}"]`);
        if (el) positionMark(el, mate);
      }
      paintGangBoxes();
      scheduleSave();
      return;
    }
    if (isSegment(p) || isWhitebox(p)) {
      p.x1 += dx;
      p.y1 += dy;
      p.x2 += dx;
      p.y2 += dy;
      if (p.kind === "line") {
        p.a1 = null;
        p.a2 = null;
      }
    } else {
      p.x += dx;
      p.y += dy;
    }
    updateMark(p);
    scheduleSave();
  }
}

function onKeyUp(e) {
  if (e.code === "Space") {
    state.space = false;
    if (!state.drag) viewport.classList.remove("panning");
  }
}

function bind() {
  $("openBtn").addEventListener("click", () => $("filePdf").click());
  $("emptyOpen").addEventListener("click", () => $("filePdf").click());
  $("sampleBtn").addEventListener("click", () => openSample());
  $("addBtn").addEventListener("click", () => $("fileAdd").click());
  $("legendBtn").addEventListener("click", () => addLegend());
  $("lineBtn").addEventListener("click", () => setTool("line"));
  $("layoutBtn").addEventListener("click", () => setTool("layout"));
  $("whiteboxBtn").addEventListener("click", () => setTool("whitebox"));
  $("arrowBtn").addEventListener("click", () => setTool("arrow"));
  $("noteBtn").addEventListener("click", () => setTool("note"));
  $("dropLegendBtn").addEventListener("click", () => setTool("legend"));
  $("noteText").addEventListener("focus", () => {
    noteUndoArmed = true;
  });
  $("noteText").addEventListener("input", () => {
    const p = selected();
    if (!p || p.kind !== "note") return;
    if (noteUndoArmed) {
      pushUndo();
      noteUndoArmed = false;
    }
    const next = cleanNote($("noteText").value);
    if (next !== $("noteText").value) $("noteText").value = next;
    p.text = next;
    updateNote(p);
    scheduleSave();
  });
  $("circuitsBtn").addEventListener("click", () => {
    state.showCircuits = !state.showCircuits;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("snapToggle").addEventListener("change", () => {
    state.snap = $("snapToggle").checked;
    saveLayout();
  });
  $("exportLayers").addEventListener("change", () => {
    state.exportAllLayers = $("exportLayers").checked;
    saveLayout();
  });
  $("layerSelect").addEventListener("change", () => {
    const p = selected();
    if (!p) return;
    if ($("layerSelect").value === "__custom__") {
      $("layerCustomField").hidden = false;
      $("layerCustom").focus();
      $("layerCustom").select();
      return;
    }
    pushUndo();
    p.layer = $("layerSelect").value;
    $("layerCustomField").hidden = true;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("layerCustom").addEventListener("change", () => {
    const p = selected();
    if (!p) return;
    const name = normalizeLayer($("layerCustom").value, "");
    if (!name) {
      toast("Type a layer name.");
      return;
    }
    pushUndo();
    p.layer = name;
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("circuitInput").addEventListener("focus", () => {
    circuitUndoArmed = true;
  });
  $("circuitInput").addEventListener("input", () => {
    const p = selected();
    if (!p) return;
    if (circuitUndoArmed) {
      pushUndo();
      circuitUndoArmed = false;
    }
    const next = cleanCircuit($("circuitInput").value);
    if (next) p.circuit = next;
    else delete p.circuit;
    if (isSymbol(p) && p.circuit) {
      for (const line of state.placements) {
        if (line.kind !== "line" || line.guide || line.circuit) continue;
        if (line.a1 === p.id || line.a2 === p.id) line.circuit = p.circuit;
      }
    }
    if (state.showCircuits) renderMarks();
    scheduleSave();
  });
  $("heightInput").addEventListener("focus", () => {
    heightUndoArmed = true;
  });
  $("heightInput").addEventListener("input", () => {
    const p = selected();
    if (!p || !takesHeight(p.symbolId)) return;
    if (heightUndoArmed) {
      pushUndo();
      heightUndoArmed = false;
    }
    const next = cleanHeight($("heightInput").value, false);
    if (next) p.height = next;
    else delete p.height;
    state.outletHeight = next;
    renderMarks();
    scheduleSave();
  });
  $("heightInput").addEventListener("blur", () => {
    const p = selected();
    if (!p || !takesHeight(p.symbolId)) return;
    const next = cleanHeight($("heightInput").value, true);
    if (next) p.height = next;
    else delete p.height;
    state.outletHeight = next;
    $("heightInput").value = next;
    renderMarks();
    scheduleSave();
  });
  $("freePlace").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    if ($("freePlace").checked) p.freePlace = true;
    else delete p.freePlace;
    scheduleSave();
  });
  $("reviseBtn").addEventListener("click", () => exportPdf(true));
  $("exportBtn").addEventListener("click", () => exportPdf(false));
  $("saveBtn").addEventListener("click", () => saveProject());
  $("loadBtn").addEventListener("click", () => $("fileProj").click());
  $("helpBtn").addEventListener("click", () => $("help").showModal());
  $("filePdf").addEventListener("change", () => {
    const file = $("filePdf").files[0];
    $("filePdf").value = "";
    if (file) openFile(file);
  });
  $("fileAdd").addEventListener("change", () => {
    const file = $("fileAdd").files[0];
    $("fileAdd").value = "";
    if (file) openFile(file, { append: true });
  });
  $("fileProj").addEventListener("change", () => {
    const file = $("fileProj").files[0];
    $("fileProj").value = "";
    if (file) loadProjectFile(file);
  });
  $("prevPage").addEventListener("click", () => goToPage(state.pageIndex - 1));
  $("nextPage").addEventListener("click", () => goToPage(state.pageIndex + 1));
  $("pageSelect").addEventListener("change", () => goToPage(Number($("pageSelect").value)));
  $("zoomIn").addEventListener("click", () => {
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1.15);
  });
  $("zoomOut").addEventListener("click", () => {
    const vr = viewport.getBoundingClientRect();
    zoomAt(vr.left + vr.width / 2, vr.top + vr.height / 2, 1 / 1.15);
  });
  $("zoomLabel").addEventListener("click", () => actualSize());
  $("fitBtn").addEventListener("click", () => fitView());
  $("filter").addEventListener("input", () => renderPalette());
  $("sizeRange").addEventListener("pointerdown", () => {
    sizeUndoArmed = true;
  });
  $("sizeRange").addEventListener("input", () => {
    setSize(Number($("sizeRange").value), { undo: sizeUndoArmed });
    sizeUndoArmed = false;
  });
  for (const btn of document.querySelectorAll(".presets [data-size]")) {
    btn.addEventListener("click", () => setSize(Number(btn.dataset.size), { undo: true }));
  }
  $("applySizeBtn").addEventListener("click", () => applySizeToAll());
  for (const input of document.querySelectorAll('input[name="countScope"]')) {
    input.addEventListener("change", () => renderCounts());
  }
  $("countsSheetBtn").addEventListener("click", () => addCountsSheet());
  $("scheduleBtn").addEventListener("click", () => addScheduleSheet());
  $("countsPanel").addEventListener("toggle", () => saveLayout());
  $("sizeOneFoot").addEventListener("click", () => {
    if (!state.calibration) return;
    const raw = state.calibration.pointsPerFoot;
    const pt = clamp(raw, 10, 160);
    if (Math.abs(pt - raw) > 0.5) toast("One foot is outside the slider range, so the size was limited.");
    setSize(pt, { undo: true });
  });
  $("calibBtn").addEventListener("click", () => {
    if (state.calibStep) cancelCalib();
    else {
      state.armedId = null;
      state.tool = null;
      state.lineDraft = null;
      state.arrowDraft = null;
      state.runDraft = null;
      state.layoutDraft = null;
      state.whiteboxDraft = null;
      state.calibStep = 1;
      state.calibDraft = null;
      renderPalette();
      syncInspector();
      renderMarks();
      setStatus();
    }
  });
  $("calibClear").addEventListener("click", () => {
    pushUndo();
    state.calibration = null;
    syncInspector();
    drawCalib();
    scheduleSave();
    setStatus();
  });
  $("calibApply").addEventListener("click", () => applyCalibration());
  $("calibLen").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyCalibration();
    }
  });
  $("symbolSelect").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.symbolId = $("symbolSelect").value;
    if (!takesHeight(p.symbolId)) delete p.height;
    if (!state.ink) p.color = (symbolsById[p.symbolId] && symbolsById[p.symbolId].defaultColor) || "#141414";
    rememberSymbol(p.symbolId);
    if (!isSwitchSymbol(p)) {
      delete p.groupId;
      delete p.gang;
    }
    dissolveThinGroups();
    renderMarks();
    syncInspector();
    scheduleSave();
  });
  $("rotMinus").addEventListener("click", () => bumpRotation(-15));
  $("rotPlus").addEventListener("click", () => bumpRotation(15));
  $("rot90").addEventListener("click", () => bumpRotation(90));
  $("rot0").addEventListener("click", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.rotation = 0;
    updateMark(p);
    scheduleSave();
  });
  $("rotInput").addEventListener("change", () => {
    const p = selected();
    if (!isSymbol(p)) return;
    pushUndo();
    p.rotation = normRot($("rotInput").value);
    updateMark(p);
    scheduleSave();
  });
  $("dupBtn").addEventListener("click", () => duplicateSelected());
  $("delBtn").addEventListener("click", () => deleteSelected());
  $("groupBtn").addEventListener("click", () => groupSwitches());
  $("ungroupBtn").addEventListener("click", () => ungroupSwitches());
  $("sheetsDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("sheetsDialog").close("keep");
  });
  $("recoverYes").addEventListener("click", () => restoreRecovery());
  $("recoverNo").addEventListener("click", () => dismissRecovery());
  startRecoveryTimer();
  window.addEventListener("beforeunload", () => {
    writeRecovery(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") writeRecovery(true);
  });

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("contextmenu", (e) => e.preventDefault());
  viewport.addEventListener("wheel", (e) => {
    if (!state.doc) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 0.04 : 0.0015;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * scale));
  }, { passive: false });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  bindSplitters();
  window.addEventListener("blur", () => {
    state.space = false;
    viewport.classList.remove("panning");
  });
  window.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    document.body.classList.add("dropping");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.target === document.body || e.target === document.documentElement) {
      document.body.classList.remove("dropping");
    }
  });
  window.addEventListener("drop", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    document.body.classList.remove("dropping");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith(".json")) loadProjectFile(file);
    else openFile(file);
  });
  $("help").addEventListener("click", (e) => {
    if (e.target === $("help")) $("help").close();
  });
}

function readLen(name, fallback) {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
}

function setLen(name, value, min, max) {
  const next = clamp(value, min, max);
  document.documentElement.style.setProperty(name, next + "px");
  return next;
}

function loadLayout() {
  try {
    const data = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    if (Array.isArray(data.open)) openCategories = new Set(data.open.filter((id) => typeof id === "string"));
    if (typeof data.countsOpen === "boolean") $("countsPanel").open = data.countsOpen;
    if (data.sideWidth) setLen("--side-width", data.sideWidth, 220, 560);
    if (data.toolsHeight) setLen("--tools-height", data.toolsHeight, 140, 720);
    if (data.toolsWidth) setLen("--tools-width", data.toolsWidth, 180, 480);
    if (typeof data.snap === "boolean") state.snap = data.snap;
    if (typeof data.exportAllLayers === "boolean") state.exportAllLayers = data.exportAllLayers;
    if (Array.isArray(data.recent)) {
      recentSymbols = data.recent.filter((id) => typeof id === "string").slice(0, 6);
    }
  } catch (_err) {
    /* keep the built-in sizes */
  }
}

function saveLayout() {
  const data = {
    open: [...openCategories],
    sideWidth: readLen("--side-width", 300),
    toolsHeight: readLen("--tools-height", 340),
    toolsWidth: readLen("--tools-width", 260),
    countsOpen: $("countsPanel").open,
    snap: state.snap,
    exportAllLayers: state.exportAllLayers,
    recent: recentSymbols,
  };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  } catch (_err) {
    /* private mode can refuse storage */
  }
}

function panelAxis() {
  return window.matchMedia("(max-width: 860px) and (min-width: 561px)").matches ? "x" : "y";
}

function dragSplitter(el, apply) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const axis = apply.axis ? apply.axis() : "y";
    const start = { x: e.clientX, y: e.clientY, ...apply.start() };
    el.classList.add("dragging");
    document.body.classList.add(axis === "x" ? "col-resize" : "row-resize");
    const move = (ev) => apply.move(ev.clientX - start.x, ev.clientY - start.y, start);
    const up = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("col-resize", "row-resize");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveLayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 24 : 12;
    const key = e.key;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = key === "ArrowLeft" || key === "ArrowUp" ? -step : step;
    apply.nudge(dir, key);
    saveLayout();
  });
  el.addEventListener("dblclick", () => {
    apply.reset();
    saveLayout();
  });
}

function bindSplitters() {
  const aside = document.querySelector("aside");
  dragSplitter($("panelSplit"), {
    axis: panelAxis,
    start() {
      return panelAxis() === "x"
        ? { size: readLen("--tools-width", 260) }
        : { size: readLen("--tools-height", 340) };
    },
    move(dx, dy, start) {
      if (panelAxis() === "x") {
        const max = Math.max(180, aside.clientWidth - 160);
        setLen("--tools-width", start.size - dx, 180, Math.min(480, max));
      } else {
        const max = Math.max(140, aside.clientHeight - 100);
        setLen("--tools-height", start.size - dy, 140, Math.min(720, max));
      }
    },
    nudge(dir) {
      if (panelAxis() === "x") setLen("--tools-width", readLen("--tools-width", 260) - dir, 180, 480);
      else setLen("--tools-height", readLen("--tools-height", 340) - dir, 140, 720);
    },
    reset() {
      document.documentElement.style.removeProperty("--tools-height");
      document.documentElement.style.removeProperty("--tools-width");
    },
  });
  dragSplitter($("sideSplit"), {
    axis: () => "x",
    start: () => ({ size: readLen("--side-width", 300) }),
    move(dx, _dy, start) {
      const max = Math.min(560, window.innerWidth - 320);
      setLen("--side-width", start.size + dx, 220, Math.max(220, max));
    },
    nudge(dir, key) {
      if (key === "ArrowUp" || key === "ArrowDown") return;
      setLen("--side-width", readLen("--side-width", 300) + dir, 220, 560);
    },
    reset() {
      document.documentElement.style.removeProperty("--side-width");
    },
  });
}

async function init() {
  loadLayout();
  const res = await fetch("/api/symbols");
  if (!res.ok) {
    toast("Could not load the symbol library.");
    return;
  }
  library = await res.json();
  symbolsById = Object.fromEntries(library.symbols.map((sym) => [sym.id, sym]));
  recentSymbols = recentSymbols.filter((id) => symbolsById[id]);
  buildSymbolSelect();
  buildColors();
  renderPalette();
  renderCounts();
  syncInspector();
  setStatus();
  bind();
}

init();
