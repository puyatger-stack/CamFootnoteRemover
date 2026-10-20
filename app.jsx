/* ScanFix — fully client-side scan cleaner (React, no backend, no build step).
 * 1) Renders every PDF page / image to a canvas.
 * 2) Crops with percentage boxes:
 *      - Watermark footer removal : keep 0%..(100 - trim)%, drop the bottom 6–8%.
 *      - ID halves                : front = 0–48%, back = 50%..(95% or the watermark line).
 * 3) Exports one merged PDF, or any subset of frames as individual PNGs.
 */
const { useState, useEffect, useRef, useCallback } = React;

/* Renders PDF pages at roughly A4 @150 DPI (≈1240 px wide), matching the
 * pixel box in the spec (1240 x 1754 → strip ≈130 px ≈ 7.4 %). */
const RENDER_WIDTH = 1240;
const PDF_WORKER =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

/* ------------------------------------------------------------------ utils */

const uid = () =>
  "i" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

const sanitize = (name) =>
  String(name || "scan")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "scan";

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image: " + file.name));
    };
    img.src = url;
  });
}

/** Percentage crop. xPct/yPct = origin, wPct/hPct = size, all in 0..100. */
function cropCanvas(src, xPct, yPct, wPct, hPct) {
  const sw = src.width;
  const sh = src.height;
  const x = Math.max(0, Math.round((sw * xPct) / 100));
  const y = Math.max(0, Math.round((sh * yPct) / 100));
  const w = Math.min(sw - x, Math.round((sw * wPct) / 100));
  const h = Math.min(sh - y, Math.round((sh * hPct) / 100));
  const out = makeCanvas(w, h);
  out.getContext("2d").drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

function thumbOf(canvas, maxW) {
  const s = Math.min(1, maxW / canvas.width);
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(canvas.width * s));
  t.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = t.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, t.width, t.height);
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.72);
}

/* --------------------------------------------------- input → source sheets */

async function fileToSheets(file, onProgress) {
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");

  if (isPdf) {
    const lib = window.pdfjsLib;
    if (!lib) throw new Error("PDF engine not loaded — check your connection and reload.");
    onProgress("Reading " + file.name + " …");
    const data = await file.arrayBuffer();
    const pdf = await lib.getDocument({ data }).promise;
    const sheets = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress("Rendering " + file.name + " — page " + p + "/" + pdf.numPages + " …");
      const page = await pdf.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(1.5, RENDER_WIDTH / base.width));
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(viewport.width, viewport.height);
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
      sheets.push({ id: uid(), name: file.name, page: p, pages: pdf.numPages, canvas });
    }
    return sheets;
  }

  onProgress("Reading " + file.name + " …");
  const img = await loadImageFile(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = w > RENDER_WIDTH ? RENDER_WIDTH / w : 1;
  const canvas = makeCanvas(w * scale, h * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return [{ id: uid(), name: file.name, page: 1, pages: 1, canvas }];
}

/* --------------------------------------------------------- result frames */

function buildFrames(sources, mode, trimPct, topTrimPct) {
  const effTop = Math.max(0, topTrimPct);
  const effBottom = Math.max(0, trimPct);
  const keepH = Math.max(10, 100 - effTop - effBottom);

  const nameCount = {};
  sources.forEach((s) => {
    nameCount[s.name] = (nameCount[s.name] || 0) + 1;
  });

  const mk = (src, filename, label, canvas) => ({
    id: uid(),
    filename,
    label,
    canvas,
    thumb: thumbOf(canvas, 360),
    width: canvas.width,
    height: canvas.height,
    selected: true,
  });

  const frames = [];
  sources.forEach((s) => {
    const base = sanitize(s.name);
    const suffix = nameCount[s.name] > 1 ? "_p" + s.page : "";
    if (mode === "halves") {
      // Front ID usually occupies top 0-48%
      const frontH = Math.min(48, keepH);
      frames.push(
        mk(s, base + suffix + "_front", s.name + " · p" + s.page + " · front ID", cropCanvas(s.canvas, 0, effTop, 100, frontH))
      );
      // Back ID starts at 50%
      const backH = Math.max(5, Math.min(45, 100 - 50 - effBottom));
      frames.push(
        mk(s, base + suffix + "_back", s.name + " · p" + s.page + " · back ID", cropCanvas(s.canvas, 0, 50, 100, backH))
      );
    } else {
      frames.push(mk(s, base + suffix, s.name + " · p" + s.page, cropCanvas(s.canvas, 0, effTop, 100, keepH)));
    }
  });

  // de-duplicate output file names
  const seen = {};
  frames.forEach((f) => {
    if (seen[f.filename]) f.filename = f.filename + "_" + ++seen[f.filename];
    else seen[f.filename] = 1;
  });
  return frames;
}

/* ------------------------------------------------------------- exporting */

function downloadPng(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename + ".png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve();
      }, 450);
    }, "image/png");
  });
}

/** Merges the given frames into a single PDF; each frame keeps its own page size. */
function downloadMergedPdf(frames, filename) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  frames.forEach((f, i) => {
    const c = f.canvas;
    const wPt = c.width * 0.75; // px @96dpi → pt
    const hPt = c.height * 0.75;
    const orientation = wPt > hPt ? "l" : "p";
    if (i === 0) {
      doc = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation, compress: true });
    } else {
      doc.addPage([wPt, hPt], orientation);
    }
    doc.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, wPt, hPt, undefined, "FAST");
  });
  if (doc) doc.save(filename);
}

/* ------------------------------------------------------------------- app */

function App() {
  const [sources, setSources] = useState([]);
  const [frames, setFrames] = useState([]);
  const [mode, setMode] = useState("page"); // "page" | "halves"
  const [trimPct, setTrimPct] = useState(7); // bottom band to cut (6–8 %)
  const [topTrimPct, setTopTrimPct] = useState(2); // top band to cut
  const [keepWatermark, setKeepWatermark] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState("");
  const inputRef = useRef(null);

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError("");
    const collected = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setBusy("Loading " + f.name + " (" + (i + 1) + "/" + files.length + ") …");
      try {
        const sheets = await fileToSheets(f, setBusy);
        collected.push(...sheets);
      } catch (e) {
        setError((e && e.message) || String(e));
      }
    }
    if (collected.length) setSources((prev) => prev.concat(collected));
    setBusy("");
  }, []);

  // Recompute every frame whenever inputs or settings change.
  useEffect(() => {
    if (!sources.length) {
      setFrames([]);
      return;
    }
    setFrames(buildFrames(sources, mode, keepWatermark ? 0 : trimPct, keepWatermark ? 0 : topTrimPct));
  }, [sources, mode, trimPct, topTrimPct, keepWatermark]);

  const selectAll = (v) => setFrames((prev) => prev.map((f) => ({ ...f, selected: v })));
  const toggle = (id) =>
    setFrames((prev) => prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)));

  const chosen = frames.filter((f) => f.selected);

  const doMergedPdf = async () => {
    if (!chosen.length) return;
    setExporting("Building PDF …");
    try {
      downloadMergedPdf(chosen, mode === "halves" ? "id-cards-cleaned.pdf" : "scans-cleaned.pdf");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
    setExporting("");
  };

  const doSelectedPngs = async () => {
    if (!chosen.length) return;
    for (let i = 0; i < chosen.length; i++) {
      setExporting("Saving PNG " + (i + 1) + "/" + chosen.length + " …");
      await downloadPng(chosen[i].canvas, chosen[i].filename);
    }
    setExporting("");
  };

  const clearAll = () => {
    setSources([]);
    setFrames([]);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer && e.dataTransfer.files);
  };

  const effTrim = keepWatermark ? 0 : trimPct;

  return (
    <div className="wrap">
      <header>
        <h1>
          Scan<span>Fix</span>
        </h1>
        <p className="sub">
          Drop in a PDF or scan images, automatically cut off the
          &ldquo;Scanned with CamScanner&rdquo; footer, optionally split the page into
          front / back ID halves, then export everything as one PDF or as hand-picked PNGs.
        </p>
      </header>

      <div className="grid-2">
        {/* ------------------------------ left: input ------------------------------ */}
        <div className="card">
          <h2>1 · Add your scans</h2>
          <div
            className={"drop" + (dragging ? " over" : "")}
            onClick={() => inputRef.current && inputRef.current.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <div className="big">Drop files here, or click to browse</div>
            <div className="small">Multi-select is supported — every PDF page becomes its own frame.</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,application/pdf,image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif"
            style={{ display: "none" }}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {busy && (
            <div className="status">
              <span className="spinner" />
              <span>{busy}</span>
            </div>
          )}
          {error && <div className="error">{error}</div>}

          {sources.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="kv">
                <div>
                  <span>Files loaded</span>
                  <span>{new Set(sources.map((s) => s.name)).size}</span>
                </div>
                <div>
                  <span>Source pages / images</span>
                  <span>{sources.length}</span>
                </div>
                <div>
                  <span>Output frames</span>
                  <span>{frames.length}</span>
                </div>
              </div>
              <div className="actions" style={{ marginTop: 14 }}>
                <button className="tiny danger" onClick={clearAll}>
                  Clear all
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------ right: settings ------------------------------ */}
        <div className="card">
          <h2>2 · Crop settings</h2>

          <div className="field">
            <label className="title">Output mode</label>
            <div className="radio-list">
              <label className={"radio" + (mode === "page" ? " active" : "")}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "page"}
                  onChange={() => setMode("page")}
                />
                <span className="label">
                  Whole page, watermark removed
                </span>
              </label>
              <label className={"radio" + (mode === "halves" ? " active" : "")}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "halves"}
                  onChange={() => setMode("halves")}
                />
                <span className="label">
                  ID card halves (front + back)
                </span>
              </label>
            </div>
          </div>

          <div className="field">
            <label className="title">Top Margin trim</label>
            <div className="range-row">
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={topTrimPct}
                disabled={keepWatermark}
                onChange={(e) => setTopTrimPct(parseFloat(e.target.value))}
              />
              <span className="range-val">{keepWatermark ? "off" : topTrimPct + "%"}</span>
            </div>
          </div>

          <div className="field">
            <label className="title">Watermark footer trim</label>
            <div className="range-row">
              <input
                type="range"
                min="0"
                max="14"
                step="0.5"
                value={trimPct}
                disabled={keepWatermark}
                onChange={(e) => setTrimPct(parseFloat(e.target.value))}
              />
              <span className="range-val">{keepWatermark ? "off" : trimPct + "%"}</span>
            </div>
            <div className="presets">
              {[6, 7.5, 8].map((v) => (
                <button
                  key={v}
                  className="tiny"
                  disabled={keepWatermark}
                  onClick={() => setTrimPct(v)}
                >
                  {v}%
                </button>
              ))}
              <button className="tiny ghost" disabled={keepWatermark} onClick={() => setTrimPct(7)}>
                reset
              </button>
            </div>
            <div style={{ marginTop: 10 }}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={keepWatermark}
                  onChange={(e) => setKeepWatermark(e.target.checked)}
                />
                Keep the bottom margin (do not remove watermark)
              </label>
            </div>
          </div>

          <div className="field">
            <label className="title">Export</label>
            <div className="actions">
              <button className="primary" disabled={!chosen.length || !!exporting} onClick={doMergedPdf}>
                Single merged PDF ({chosen.length})
              </button>
              <button className="green" disabled={!chosen.length || !!exporting} onClick={doSelectedPngs}>
                Selected PNGs
              </button>
            </div>
            <div className="presets">
              <button className="tiny" onClick={() => selectAll(true)} disabled={!frames.length}>
                Select all
              </button>
              <button className="tiny" onClick={() => selectAll(false)} disabled={!frames.length}>
                Select none
              </button>
            </div>
            {exporting && (
              <div className="status">
                <span className="spinner" />
                <span>{exporting}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------ results ------------------------------ */}
      {frames.length > 0 && (
        <>
          <div className="results-head">
            <h2>3 · Preview &amp; pick</h2>
            <div className="meta">
              {chosen.length} of {frames.length} frames selected — click a preview to toggle it
            </div>
          </div>
          <div className="thumbs">
            {frames.map((f) => (
              <div key={f.id} className={"thumb " + (f.selected ? "on" : "off")}>
                <div className="imgbox" onClick={() => toggle(f.id)}>
                  <img src={f.thumb} alt={f.label} />
                  <span className="tick">{f.selected ? "✓" : ""}</span>
                </div>
                <div className="info">
                  <div className="name">{f.label}</div>
                  <div className="dims">
                    {f.width} × {f.height} px
                  </div>
                  <button className="dl ghost" onClick={() => downloadPng(f.canvas, f.filename)}>
                    Download PNG
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
