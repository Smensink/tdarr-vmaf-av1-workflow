"use strict";

async function getJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toFixed(digits);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
}

function setStatus(summary) {
  const ds = document.getElementById("dataStatus");
  const r = summary.csv.results;
  const l = summary.csv.learning;
  ds.textContent =
    `results: ${r.exists ? "ok" : "missing"}  path=${r.path}  mtime=${r.mtime || "—"}  size=${r.sizeBytes || 0}\n` +
    `learning: ${l.exists ? "ok" : "missing"} path=${l.path} mtime=${l.mtime || "—"} size=${l.sizeBytes || 0}`;
}

function setSummary(summary) {
  const kv = document.getElementById("summary");
  kv.innerHTML = "";
  const items = [
    ["Runs parsed", summary.counts.runsParsed],
    ["Runs with sampleCount", summary.counts.runsWithSampleCount],
    ["Runs with selected CQ", summary.counts.runsWithSelectedCq],
    ["Learning rows", summary.counts.learningRows],
    ["SampleCount median", fmt(summary.stats.sampleCount.median, 2)],
    ["SampleCount p20-p80", `${fmt(summary.stats.sampleCount.p20, 2)} – ${fmt(summary.stats.sampleCount.p80, 2)}`],
    ["Selected CQ median", fmt(summary.stats.selectedCq.median, 2)],
    ["Learned CQ median", fmt(summary.stats.learnedSelectedCq.median, 2)],
  ];
  for (const [k, v] of items) {
    kv.appendChild(
      el("div", { class: "item" }, [el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) })]),
    );
  }
}

function fillSelect(selectEl, values, { includeAny = true, anyLabel = "Any", anyValue = "" } = {}) {
  selectEl.innerHTML = "";
  if (includeAny) {
    selectEl.appendChild(el("option", { value: anyValue, text: anyLabel }));
  }
  for (const v of values) {
    selectEl.appendChild(el("option", { value: String(v), text: String(v) }));
  }
}

async function initConfigurator() {
  const cfg = await getJson("/api/config/options");
  const opts = cfg.options || {};

  fillSelect(document.getElementById("cfgResTier"), opts.resTier || [], { includeAny: true });
  fillSelect(document.getElementById("cfgCodecCat"), opts.codecCat || [], { includeAny: true });
  fillSelect(document.getElementById("cfgBitrate"), opts.bitrateBucket || [], { includeAny: true });
  fillSelect(document.getElementById("cfgBpp"), opts.bppBucket || [], { includeAny: true });
  fillSelect(document.getElementById("cfgMediaType"), opts.mediaType || [], { includeAny: true });
  fillSelect(document.getElementById("cfgSourceType"), opts.sourceType || [], { includeAny: true });

  const genres = (cfg.topGenres || []).map((g) => g.genre).filter(Boolean);
  fillSelect(document.getElementById("cfgGenre"), genres, { includeAny: true, anyLabel: "Any" });
}

function setConfiguratorResult(rec) {
  const status = document.getElementById("cfgStatus");
  const out = document.getElementById("cfgResult");
  out.innerHTML = "";

  const eff = rec.effectiveInput || {};
  const learned = rec.learnedCqRange || {};
  const adaptive = rec.adaptiveSamples || {};

  const sourceLabel = eff.mediaSourceType ? eff.mediaSourceType : "-";
  status.textContent = `effective: ${eff.resTier || "-"} ${eff.codecCat || "-"} bitrate=${eff.bitrateMbps ?? "-"}Mbps source=${sourceLabel}`;

  const learnedText =
    learned.ok && learned.min !== undefined && learned.max !== undefined
      ? `${learned.min} - ${learned.max} (n=${learned.sampleCount}, conf=${fmt(learned.confidence, 2)}${learned.looseUsed ? ", loose" : ""}${learned.estimatedUsed ? `, estUsed=${learned.estimatedUsed}` : ""}${learned.estimatedMeanConfidence !== null && learned.estimatedMeanConfidence !== undefined ? `, estConf=${fmt(learned.estimatedMeanConfidence, 2)}` : ""})`
      : `- (${learned.reason || "no learned CQ range"})`;

  const adaptiveText =
    adaptive.recommended !== null && adaptive.recommended !== undefined
      ? `${adaptive.recommended} (predStd=${fmt(adaptive.predictedStd, 3)})`
      : `- (${adaptive.reason || "no adaptive sample recommendation"})`;

  const items = [
    ["Adaptive samples (Tdarr)", adaptiveText],
    ["Learned CQ range preload (Tdarr)", learnedText],
    ["Sample model", adaptive.model ? `rows=${adaptive.model.rows} rmse=${fmt(adaptive.model.rmse, 3)}` : "-"],
    ["Learning filters", `minSamples=${eff.learningMinSamples ?? "-"} tol=${eff.learningBitrateTolerance ?? "-"}% onlySuccess=${String(eff.learningOnlySuccesses)}`],
  ];
  for (const [k, v] of items) {
    out.appendChild(el("div", { class: "item" }, [el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) })]));
  }
}

async function runConfigurator() {
  const params = new URLSearchParams();
  const setIf = (k, v) => {
    if (v !== null && v !== undefined && String(v) !== "") params.set(k, String(v));
  };

  setIf("resTier", document.getElementById("cfgResTier").value);
  setIf("codecCat", document.getElementById("cfgCodecCat").value);
  setIf("isHdr", document.getElementById("cfgHdr").value);
  setIf("mediaIsAnimation", document.getElementById("cfgAnim").value);
  setIf("bitrateBucket", document.getElementById("cfgBitrate").value);
  setIf("bppBucket", document.getElementById("cfgBpp").value);
  setIf("mediaType", document.getElementById("cfgMediaType").value);
  setIf("sourceType", document.getElementById("cfgSourceType").value);
  setIf("genre", document.getElementById("cfgGenre").value);
  setIf("bitrateMbps", document.getElementById("cfgBitrateMbps").value);
  setIf("durationMin", document.getElementById("cfgDurationMin").value);
  setIf("mediaYear", document.getElementById("cfgYear").value);
  setIf("releaseGroup", document.getElementById("cfgReleaseGroup").value);
  setIf("learningMinSamples", document.getElementById("cfgLearnMinSamples").value);
  setIf("learningBitrateTolerance", document.getElementById("cfgLearnTol").value);
  setIf("learningOnlySuccesses", document.getElementById("cfgLearnOnlySuccess").value);
  setIf("minSegments", document.getElementById("cfgMinSeg").value);
  setIf("maxSegments", document.getElementById("cfgMaxSeg").value);
  setIf("title", document.getElementById("cfgTitle").value);

  const rec = await getJson(`/api/config/tdarr-recommend?${params.toString()}`);
  setConfiguratorResult(rec);
}

function renderTable(containerId, rows, columns) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = "";
  const table = el("table");
  const thead = el("thead");
  const trh = el("tr");
  for (const c of columns) trh.appendChild(el("th", { text: c.label }));
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of columns) {
      const val = c.value(r);
      tr.appendChild(el("td", { class: c.mono ? "mono" : "", text: String(val) }));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function renderBarChart(containerId, breakdown, valueKey = "median", color = "#6ea8fe") {
  const elc = document.getElementById(containerId);
  elc.innerHTML = "";

  const items = breakdown.slice(0, 12);
  const values = items.map((d) => Number(d[valueKey] ?? 0)).filter((v) => Number.isFinite(v));
  const maxVal = values.length ? Math.max(...values) : 1;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 220");

  const padL = 140;
  const padR = 18;
  const padT = 10;
  const rowH = 16;
  const gap = 6;

  for (let i = 0; i < items.length; i++) {
    const y = padT + i * (rowH + gap);
    const k = items[i].key;
    const v = Number(items[i][valueKey]);
    const w = Number.isFinite(v) ? ((900 - padL - padR) * v) / maxVal : 0;

    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", String(padL - 10));
    label.setAttribute("y", String(y + 12));
    label.setAttribute("fill", "rgba(233,238,252,0.85)");
    label.setAttribute("font-size", "11");
    label.setAttribute("text-anchor", "end");
    label.textContent = k;
    svg.appendChild(label);

    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(padL));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(Math.max(0, w)));
    rect.setAttribute("height", String(rowH));
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", color);
    rect.setAttribute("opacity", "0.85");
    svg.appendChild(rect);

    const valText = document.createElementNS(svg.namespaceURI, "text");
    valText.setAttribute("x", String(padL + Math.max(0, w) + 8));
    valText.setAttribute("y", String(y + 12));
    valText.setAttribute("fill", "rgba(169,182,211,0.95)");
    valText.setAttribute("font-size", "11");
    valText.textContent = Number.isFinite(v) ? v.toFixed(2) : "—";
    svg.appendChild(valText);
  }

  elc.appendChild(svg);
}

function renderHistogram(containerId, bins, { max, binWidth, onBinClick } = {}) {
  const elc = document.getElementById(containerId);
  elc.innerHTML = "";

  const items = Array.isArray(bins) ? bins : [];
  if (!items.length) {
    elc.textContent = "no data";
    return;
  }

  const values = items.map((b) => Number(b.count || 0)).filter((v) => Number.isFinite(v));
  const maxCount = values.length ? Math.max(...values) : 1;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 220");

  const padL = 40;
  const padR = 18;
  const padT = 10;
  const padB = 28;
  const chartH = 220 - padT - padB;
  const chartW = 900 - padL - padR;
  const barW = chartW / items.length;

  const axis = document.createElementNS(svg.namespaceURI, "line");
  axis.setAttribute("x1", String(padL));
  axis.setAttribute("y1", String(padT + chartH));
  axis.setAttribute("x2", String(padL + chartW));
  axis.setAttribute("y2", String(padT + chartH));
  axis.setAttribute("stroke", "rgba(169,182,211,0.5)");
  axis.setAttribute("stroke-width", "1");
  svg.appendChild(axis);

  for (let i = 0; i < items.length; i++) {
    const c = Number(items[i].count || 0);
    const h = maxCount > 0 ? (chartH * c) / maxCount : 0;
    const x = padL + i * barW;
    const y = padT + chartH - h;
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(Math.max(1, barW - 1)));
    rect.setAttribute("height", String(Math.max(0, h)));
    rect.setAttribute("fill", "rgba(255,204,102,0.85)");
    rect.setAttribute("rx", "2");

    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = `${fmt(items[i].start, 2)} - ${fmt(items[i].end, 2)} : ${c}`;
    rect.appendChild(title);

    if (typeof onBinClick === "function") {
      rect.style.cursor = "pointer";
      rect.addEventListener("click", () => onBinClick(items[i]));
    }

    svg.appendChild(rect);
  }

  const label = document.createElementNS(svg.namespaceURI, "text");
  label.setAttribute("x", String(padL));
  label.setAttribute("y", String(212));
  label.setAttribute("fill", "rgba(169,182,211,0.95)");
  label.setAttribute("font-size", "11");
  label.textContent = `stddev (0 .. ${max ?? fmt(items[items.length - 1].end, 2)}, bin=${binWidth ?? "-"})`;
  svg.appendChild(label);

  elc.appendChild(svg);
}

function renderEncodeTrend(points, windowDays = 0) {
  const wrap = document.getElementById("retryChart");
  const statsEl = document.getElementById("retryStats");
  wrap.innerHTML = "";
  statsEl.textContent = "";
  const items = Array.isArray(points) ? points.filter((p) => Number.isFinite(Number(p.encodes))) : [];
  if (!items.length) {
    wrap.textContent = "no data";
    statsEl.textContent = "no encode data";
    return;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 240");
  const padL = 50;
  const padR = 20;
  const padT = 8;
  const padB = 36;
  const chartW = 900 - padL - padR;
  const chartH = 240 - padT - padB;
  const maxY = Math.max(1, ...items.map((p) => Number(p.encodes) || 0));
  const step = items.length > 1 ? chartW / (items.length - 1) : 0;

  const axis = document.createElementNS(svg.namespaceURI, "line");
  axis.setAttribute("x1", String(padL));
  axis.setAttribute("x2", String(padL));
  axis.setAttribute("y1", String(padT));
  axis.setAttribute("y2", String(padT + chartH));
  axis.setAttribute("stroke", "rgba(169,182,211,0.4)");
  axis.setAttribute("stroke-width", "1");
  svg.appendChild(axis);

  const xAxis = document.createElementNS(svg.namespaceURI, "line");
  xAxis.setAttribute("x1", String(padL));
  xAxis.setAttribute("x2", String(padL + chartW));
  xAxis.setAttribute("y1", String(padT + chartH));
  xAxis.setAttribute("y2", String(padT + chartH));
  xAxis.setAttribute("stroke", "rgba(169,182,211,0.4)");
  xAxis.setAttribute("stroke-width", "1");
  svg.appendChild(xAxis);

  let pathD = "";
  for (let i = 0; i < items.length; i++) {
    const val = Number(items[i].encodes) || 0;
    const x = padL + (items.length > 1 ? step * i : chartW / 2);
    const y = padT + chartH - (chartH * val) / maxY;
    pathD += `${i === 0 ? "M" : " L"}${x} ${y}`;
  }

  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#6ea8fe");
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);

  for (let i = 0; i < items.length; i++) {
    const point = items[i];
    const val = Number(point.encodes) || 0;
    const x = padL + (items.length > 1 ? step * i : chartW / 2);
    const y = padT + chartH - (chartH * val) / maxY;
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", String(x));
    circle.setAttribute("cy", String(y));
    circle.setAttribute("r", "3");
    circle.setAttribute("fill", "#6ea8fe");
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = `${point.day}: encodes=${fmt(val, 1)} (samples=${point.samples || 0}, CQ sets=${point.tested || 0})`;
    circle.appendChild(title);
    svg.appendChild(circle);
  }

  const stride = Math.max(1, Math.floor(items.length / 6));
  for (let i = 0; i < items.length; i += stride) {
    const x = padL + (items.length > 1 ? step * i : chartW / 2);
    const label = document.createElementNS(svg.namespaceURI, "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(padT + chartH + 16));
    label.setAttribute("fill", "rgba(169,182,211,0.9)");
    label.setAttribute("font-size", "10");
    label.setAttribute("text-anchor", "middle");
    label.textContent = String(items[i].day);
    svg.appendChild(label);
  }

  wrap.appendChild(svg);

  const latest = items[items.length - 1];
  statsEl.textContent = `window=${windowDays || items.length}d latest(${latest.day}): encodes=${fmt(latest.encodes, 1)} samples=${fmt(latest.samples, 1)} cqSets=${fmt(latest.tested, 1)}`;
}

let selectedOutlier = null;

function renderOutliers(outliers) {
  const wrap = document.getElementById("outliersTable");
  wrap.innerHTML = "";
  const table = el("table");
  const thead = el("thead");
  thead.appendChild(
    el("tr", {}, [
      el("th", { text: "std" }),
      el("th", { text: "n" }),
      el("th", { text: "param" }),
      el("th", { text: "timestamp" }),
      el("th", { text: "file" }),
      el("th", { text: "excluded" }),
    ]),
  );
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const r of outliers) {
    const tr = el("tr");
    tr.addEventListener("click", () => {
      selectedOutlier = r;
      document.getElementById("outExcludeBtn").disabled = false;
      loadOutlierDetail().catch(() => {});
    });
    tr.appendChild(el("td", { class: "mono", text: fmt(r.std, 3) }));
    tr.appendChild(el("td", { text: String(r.n ?? "-") }));
    tr.appendChild(el("td", { class: "mono", text: String(r.paramId || "-") }));
    tr.appendChild(el("td", { class: "mono", text: String(r.timestamp || "-") }));
    tr.appendChild(el("td", { class: "mono", text: String(r.filePath || "-") }));
    tr.appendChild(el("td", { text: r.excluded ? "yes" : "no" }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

async function refreshOutliers() {
  const stdMin = document.getElementById("outStdMin").value || "5.0";
  const data = await getJson(`/api/outliers/priors?stdMin=${encodeURIComponent(stdMin)}&limit=60`);
  renderOutliers(data.outliers || []);
  document.getElementById("outStatus").textContent = `outliers=${(data.outliers || []).length} stdMin=${data.stdMin}`;
}

async function loadOutlierDetail() {
  const status = document.getElementById("outStatus");
  const detail = document.getElementById("outDetail");
  if (!selectedOutlier) return;
  status.textContent = `loading job report for ${selectedOutlier.filePath} ...`;
  const jr = await getJson(`/api/outliers/jobreport?filePath=${encodeURIComponent(selectedOutlier.filePath)}`);

  const scores = jr.vmafScores || {};
  const params = Object.keys(scores);
  let lines = [];
  lines.push(`jobReport: ${jr.jobReportPath}`);
  lines.push(`keyframeAlign: ${jr.keyframeAlign === null ? "unknown" : jr.keyframeAlign}`);
  lines.push(`vmafSampleCount: ${jr.sampleCount ?? "unknown"}`);
  lines.push(`paramSets: ${params.length}`);

  // crude diagnostic: find the sample index with the lowest mean VMAF across params
  const sampleMap = new Map(); // sample -> [vmaf...]
  for (const pid of params) {
    for (const s of scores[pid] || []) {
      if (!sampleMap.has(s.sample)) sampleMap.set(s.sample, []);
      sampleMap.get(s.sample).push(Number(s.vmaf));
    }
  }
  const sampleMeans = [];
  for (const [sample, vals] of sampleMap.entries()) {
    const nums = vals.filter((v) => Number.isFinite(v));
    const m = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    sampleMeans.push({ sample, mean: m, n: nums.length });
  }
  sampleMeans.sort((a, b) => (a.mean ?? 1e9) - (b.mean ?? 1e9));
  if (sampleMeans.length) {
    const worst = sampleMeans[0];
    lines.push(`worstSampleMean: sample=${worst.sample} mean=${fmt(worst.mean, 2)} n=${worst.n}`);
  }

  detail.textContent = lines.join("\n");
  status.textContent = `selected std=${fmt(selectedOutlier.std, 3)} n=${selectedOutlier.n}`;
}

async function excludeSelectedOutlier() {
  if (!selectedOutlier) return;
  const reason = `high stddev ${fmt(selectedOutlier.std, 3)} for ${selectedOutlier.paramId}`;
  await getJson(
    `/api/exclusions/add?kind=prior&targetKey=${encodeURIComponent(selectedOutlier.priorKey)}&reason=${encodeURIComponent(reason)}`,
  );
  await refreshOutliers();
  await loadOutlierDetail();
}

async function refreshStdDistribution() {
  const bw = document.getElementById("stdBinWidth").value || "0.25";
  const max = document.getElementById("stdMax").value || "20";
  const data = await getJson(
    `/api/priors/std/distribution?binWidth=${encodeURIComponent(bw)}&max=${encodeURIComponent(max)}`,
  );
  renderHistogram("stdChart", data.bins || [], {
    max: data.max,
    binWidth: data.binWidth,
    onBinClick: async (bin) => {
      document.getElementById("outStdMin").value = String(bin.start);
      await refreshOutliers();
    },
  });

  const s = data.stats || {};
  const c = data.counts || {};
  document.getElementById("stdStats").textContent =
    `n=${s.n || 0} min=${fmt(s.min, 3)} p50=${fmt(s.p50, 3)} p90=${fmt(s.p90, 3)} p95=${fmt(s.p95, 3)} p99=${fmt(s.p99, 3)} max=${fmt(s.max, 3)}\n` +
    `included=${c.priorsIncluded || 0} excluded=${c.priorsExcluded || 0} tail(std>=${data.max})=${c.tail || 0}`;
}

async function excludePriorsByStd() {
  const stdMin = document.getElementById("stdExcludeMin").value || "10";
  const data = await getJson(`/api/exclusions/bulk/priorStd?stdMin=${encodeURIComponent(stdMin)}`);
  document.getElementById("stdStats").textContent =
    `excluded priors with std>=${data.stdMin}: added=${data.added} matched=${data.matched}\n` +
    document.getElementById("stdStats").textContent;
  await refreshStdDistribution();
  await refreshOutliers();
}

async function refreshAll() {
  const summary = await getJson("/api/summary");
  setStatus(summary);
  setSummary(summary);

  const samplesBy = document.getElementById("samplesBy").value;
  const cqBy = document.getElementById("cqBy").value;
  const learnBy = document.getElementById("learnBy").value;

  const samples = await getJson(`/api/samples/breakdown?by=${encodeURIComponent(samplesBy)}`);
  renderBarChart("samplesChart", samples.breakdown, "median", "#7ee787");
  renderTable(
    "samplesTable",
    samples.breakdown.slice(0, 16),
    [
      { label: "Group", value: (r) => r.key, mono: true },
      { label: "n", value: (r) => r.count },
      { label: "median", value: (r) => fmt(r.median, 2) },
      { label: "p20", value: (r) => fmt(r.p20, 2) },
      { label: "p80", value: (r) => fmt(r.p80, 2) },
    ],
  );

  const cq = await getJson(`/api/cq/breakdown?by=${encodeURIComponent(cqBy)}`);
  renderBarChart("cqChart", cq.breakdown, "median", "#6ea8fe");
  renderTable(
    "cqTable",
    cq.breakdown.slice(0, 16),
    [
      { label: "Group", value: (r) => r.key, mono: true },
      { label: "n", value: (r) => r.count },
      { label: "median", value: (r) => fmt(r.median, 2) },
      { label: "p20", value: (r) => fmt(r.p20, 2) },
      { label: "p80", value: (r) => fmt(r.p80, 2) },
    ],
  );

  const learn = await getJson(`/api/learning/breakdown?by=${encodeURIComponent(learnBy)}&metric=rangeWidth`);
  renderBarChart("learnChart", learn.breakdown, "median", "#ffcc66");
  renderTable(
    "learnTable",
    learn.breakdown.slice(0, 16),
    [
      { label: "Group", value: (r) => r.key, mono: true },
      { label: "n", value: (r) => r.count },
      { label: "median", value: (r) => fmt(r.median, 2) },
      { label: "p20", value: (r) => fmt(r.p20, 2) },
      { label: "p80", value: (r) => fmt(r.p80, 2) },
    ],
  );

  const runs = await getJson("/api/runs?limit=40");
  renderTable(
    "runsTable",
    runs.runs,
    [
      { label: "timestamp", value: (r) => r.timestamp, mono: true },
      { label: "file", value: (r) => r.fileName || r.filePath, mono: true },
      { label: "tier", value: (r) => r.resTier },
      { label: "codec", value: (r) => r.codecCat },
      { label: "hdr", value: (r) => (r.isHdr ? "HDR" : "SDR") },
      { label: "bitrate", value: (r) => (r.bitrateMbps ? fmt(r.bitrateMbps, 2) : "—") },
      { label: "samples", value: (r) => (r.sampleCount ?? "—") },
      { label: "selSamples", value: (r) => (r.selectedSampleCount ?? "—") },
      { label: "CQ", value: (r) => (r.selectedCq ?? "—") },
      { label: "std", value: (r) => (r.vmafStddev ? fmt(r.vmafStddev, 2) : "—") },
      { label: "inferred", value: (r) => (r.inferredSelection ? "yes" : "no") },
      { label: "backfill", value: (r) => (r.backfilledFromJobReport ? "yes" : "no") },
    ],
  );

  const encodes = await getJson("/api/encodes/overtime?days=120");
  renderEncodeTrend(encodes.points || [], encodes.days || 0);

  await refreshStdDistribution();
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  refreshAll().catch((e) => alert(String(e)));
});
document.getElementById("samplesBy").addEventListener("change", () => refreshAll().catch(() => {}));
document.getElementById("cqBy").addEventListener("change", () => refreshAll().catch(() => {}));
document.getElementById("learnBy").addEventListener("change", () => refreshAll().catch(() => {}));

document.getElementById("cfgRunBtn").addEventListener("click", () => {
  runConfigurator().catch((e) => alert(String(e)));
});

document.getElementById("outRefreshBtn").addEventListener("click", () => {
  refreshOutliers().catch((e) => alert(String(e)));
});
document.getElementById("outExcludeBtn").addEventListener("click", () => {
  excludeSelectedOutlier().catch((e) => alert(String(e)));
});

document.getElementById("stdRefreshBtn").addEventListener("click", () => {
  refreshStdDistribution().catch((e) => alert(String(e)));
});
document.getElementById("stdExcludeBtn").addEventListener("click", () => {
  excludePriorsByStd().catch((e) => alert(String(e)));
});
initConfigurator().catch(() => {});
refreshAll().catch((e) => {
  console.error(e);
  alert(String(e));
});
