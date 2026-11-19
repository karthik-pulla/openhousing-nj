/* OpenHousing NJ landing page. Every number shown is computed from the published files. */
(function () {
  "use strict";
  var P = { data: "../data/published/openhousing_nj.web.json", manifest: "../data/manifest.json",
            meta: "../data/published/index_meta.json", bounds: "data/boundaries.geojson" };
  // Same diverging affordability colors as the map: reds below the NJ median, blues above it.
  var DIV = { light: ["#892b2a", "#d75853", "#ea9a93", "#86b6ef", "#3987e5", "#184f95"],
              dark:  ["#f1aea8", "#d75853", "#9e3432", "#1c5cab", "#3987e5", "#9ec5f4"] };
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !(typeof v === "number" && isNaN(v)); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var isDark = function () { return document.documentElement.dataset.theme === "dark"; };
  var ordinal = function (n) { var s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"; return n + s; };
  var rows = [], byId = {}, score = "ownership", paths = [];

  // ------------------------------------------------------------ header, theme, reveal
  var bar = $("lbar");
  var onScroll = function () { bar.classList.toggle("scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  $("theme-btn").addEventListener("click", function () {
    var t = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("oh-theme", t); } catch (e) {}
    paint(); fillMarkets();
  });
  var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); countUp(e.target); io.unobserve(e.target); } });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }) : null;
  document.querySelectorAll(".reveal").forEach(function (el, i) {
    el.style.setProperty("--rd", (i % 3) * 90 + "ms");
    if (io && !reduce) io.observe(el); else { el.classList.add("in"); }
  });

  function countUp(el) {
    el.querySelectorAll("[data-count]").forEach(function (b) {
      var end = Number(b.dataset.count), dec = Number(b.dataset.dec || 0), pre = b.dataset.pre || "", post = b.dataset.post || "";
      var fmt = function (v) { return pre + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + post; };
      if (reduce) { b.textContent = fmt(end); return; }
      var t0 = null, dur = 1200;
      var step = function (t) { if (!t0) t0 = t; var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        b.textContent = fmt(dec ? end * e : Math.round(end * e)); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  function setCount(el, value, opts) {
    opts = opts || {};
    el.dataset.count = value; if (opts.dec) el.dataset.dec = opts.dec;
    if (opts.pre) el.dataset.pre = opts.pre; if (opts.post) el.dataset.post = opts.post;
    var parent = el.closest(".reveal");
    if (parent && parent.classList.contains("in")) countUp(parent);
    else el.textContent = (opts.pre || "") + Number(value).toLocaleString("en-US", { minimumFractionDigits: opts.dec || 0, maximumFractionDigits: opts.dec || 0 }) + (opts.post || "");
  }

  // ------------------------------------------------------------ motion: headline, progress, tilt, spotlight
  (function words() {
    var h = document.querySelector(".words > span"); if (!h) return;
    var i = 0;
    var wrap = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (w) {
            if (!w) return;
            if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(w)); return; }
            var s = document.createElement("span"); s.className = "w"; s.style.setProperty("--wi", i++); s.textContent = w; frag.appendChild(s);
          });
          n.parentNode.replaceChild(frag, n);
        } else if (n.nodeType === 1) { n.classList.add("w"); n.style.setProperty("--wi", i++); }
      });
    };
    wrap(h);
  })();
  var prog = $("progress");
  var onProg = function () { var d = document.documentElement, max = d.scrollHeight - d.clientHeight; prog.style.transform = "scaleX(" + (max > 0 ? window.scrollY / max : 0) + ")"; };
  window.addEventListener("scroll", onProg, { passive: true }); onProg();
  var fine = window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (fine && !reduce) {
    var card = $("mapcard") || document.createElement("div");
    card.addEventListener("mousemove", function (e) {
      var b = card.getBoundingClientRect(), x = (e.clientX - b.left) / b.width - 0.5, y = (e.clientY - b.top) / b.height - 0.5;
      card.style.transform = "perspective(1100px) rotateY(" + (x * 5).toFixed(2) + "deg) rotateX(" + (-y * 5).toFixed(2) + "deg)";
      card.style.setProperty("--gx", (x + 0.5) * 100 + "%"); card.style.setProperty("--gy", (y + 0.5) * 100 + "%");
    });
    card.addEventListener("mouseleave", function () { card.style.transform = ""; });
    document.addEventListener("mousemove", function (e) {
      var t = e.target.closest && e.target.closest(".spot"); if (!t) return;
      var b = t.getBoundingClientRect(); t.style.setProperty("--mx", e.clientX - b.left + "px"); t.style.setProperty("--my", e.clientY - b.top + "px");
    });
  }

  // ------------------------------------------------------------ data
  function get(u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  Promise.all([get(P.data), get(P.manifest), get(P.meta)]).then(function (res) {
    var split = res[0], m = res[1], meta = res[2];
    rows = split.data.map(function (a) { var o = {}; split.columns.forEach(function (c, i) { o[c] = a[i]; }); o.geoid = String(o.geoid); return o; });
    rows.forEach(function (r) { byId[r.geoid] = r; });
    fillCopy(m, meta);
    fillMarkets();
    var best = rows.filter(function (r) { return r.ownership_rank === 1; })[0];
    if (best) $("chip-a").innerHTML = "<small>#1 to own</small><b>" + esc(best.name) + "</b>";
    $("chip-b").innerHTML = "<small>Rate used</small><b>" + Number(meta.assumptions.mortgage_rate_pct).toFixed(2) + "%</b>";
    get(P.bounds).then(drawMap).catch(function () { $("mc-loading").textContent = "The map preview couldn't load. Open the full map instead."; });
  }).catch(function () {
    $("eyebrow").textContent = "564 municipalities";
    $("mc-loading").textContent = "Data couldn't load. Serve the repository over HTTP to preview.";
  });

  function fillCopy(m, meta) {
    var d = new Date(m.published_at), when = isNaN(d) ? m.published_at : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    $("eyebrow").textContent = rows.length + " municipalities · data updated " + when;
    var a = meta.assumptions;
    setCount($("stat-rate"), Number(a.mortgage_rate_pct).toFixed(2), { dec: 2, post: "%" });
    $("f-note").textContent = a.down_payment_pct + "% down · " + a.loan_term_years + "-year fixed at " + Number(a.mortgage_rate_pct).toFixed(2) + "%";
    var groups = {}; m.sources.forEach(function (s) { groups[s.name.split("_")[0]] = 1; });
    var nSources = Object.keys(groups).length + 1;   // + NJOGIS boundaries
    var statSrc = document.querySelector('.kpi b[data-count="7"]');
    if (statSrc) setCount(statSrc, nSources);
    setCount($("b-prosp"), rows.reduce(function (s, r) { return s + (has(r.prospective_need_capped) ? r.prospective_need_capped : 0); }, 0));
    setCount($("b-qua"), rows.filter(function (r) { return r.qualified_urban_aid === true || r.qualified_urban_aid === "True"; }).length);
    setCount($("b-zri"), rows.filter(function (r) { return has(r.zri); }).length);
    $("updated-line").textContent = "Current data published " + when + ". Missing data is shown as missing; nothing is estimated or filled in.";
    var labels = { acs_municipal: "U.S. Census Bureau · ACS", acs_county: null, property_tax_municipal: "NJ DCA · Property Tax Tables",
      hud_county: "HUD · Income Limits & Fair Market Rents", fred_mortgage30: "Freddie Mac PMMS · via FRED", nzlud_municipal: "NZLUD · Eviction Lab",
      fourth_round_municipal: "NJ DCA · Fourth Round obligations", zillow_municipal: "Zillow · Home Value Index", acs_home_value_history: null };
    $("source-pills").innerHTML = m.sources.filter(function (s) { return labels[s.name] !== null; }).map(function (s) {
      return "<li><b>" + esc(labels[s.name] || s.source) + "</b><span>" + esc(s.vintage) + "</span></li>";
    }).join("") + "<li><b>NJOGIS · Municipal Boundaries</b><span>Current</span></li>";
    var notes = m.sources.map(function (s) { return s.attribution || ""; }).filter(function (x) { return /not endorsed/.test(x); })
      .map(function (x) { var i = x.indexOf("This product uses"); return i >= 0 ? x.slice(i) : x; });
    $("foot-notices").textContent = notes.join(" ") + " Map data © Mapbox © OpenStreetMap.";
  }

  function fillMarkets() {
    var brs = { ownership_score: classes("ownership_score"), rental_score: classes("rental_score") };
    var mk = function (key, rank, el, best) {
      var scored = rows.filter(function (r) { return has(r[key]); }).sort(function (a, b) { return a[rank] - b[rank]; });
      var pick = best ? scored.slice(0, 3) : scored.slice(-3).reverse();
      $(el).innerHTML = pick.map(function (r) {
        return '<li><a href="map.html#town=' + r.geoid + '"><i class="dot" style="background:' + colorFor(r[key], brs[key]) + '" aria-hidden="true"></i><span class="t">' + esc(r.name) +
          "<small>" + esc(r.county) + " County · rank " + r[rank] + " of " + scored.length + '</small></span><span class="s">' + Number(r[key]).toFixed(1) + "</span></a></li>";
      }).join("");
    };
    mk("ownership_score", "ownership_rank", "own-best", true);
    mk("ownership_score", "ownership_rank", "own-worst", false);
    mk("rental_score", "rental_rank", "rent-best", true);
    mk("rental_score", "rental_rank", "rent-worst", false);
  }

  // ------------------------------------------------------------ hero: 564-square tile wall
  // Each square is one municipality. "Ranked" sorts them most -> least affordable
  // (no-data squares last); "On the map" flies each square to its town's location.
  var stage = $("tile-stage"), tiles = [], mode = "grid", geoPts = {}, autoTimer = null, touched = false;

  function classes(key) {
    var v = rows.map(function (r) { return r[key]; }).filter(has).sort(function (a, b) { return a - b; });
    var br = []; for (var i = 1; i < 6; i++) br.push(v[Math.floor(i * v.length / 6)]);   // 6 groups, split at the median
    return br;
  }
  function colorFor(val, br) {
    if (!has(val)) return getComputedStyle(document.documentElement).getPropertyValue("--nodata").trim();
    var i = 0; while (i < br.length && val >= br[i]) i++;
    return DIV[isDark() ? "dark" : "light"][i];
  }

  function drawMap(gj) {
    // town centroids (mean of boundary points), projected with a cos(latitude) stretch
    var kx = Math.cos(40.1 * Math.PI / 180), minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, raw = {};
    gj.features.forEach(function (f) {
      var polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates, sx = 0, sy = 0, n = 0;
      polys.forEach(function (p) { p[0].forEach(function (c) { sx += c[0] * kx; sy += -c[1]; n++; }); });
      var x = sx / n, y = sy / n; raw[f.properties.geoid] = [x, y];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    Object.keys(raw).forEach(function (g) { geoPts[g] = [(raw[g][0] - minX) / (maxY - minY), (raw[g][1] - minY) / (maxY - minY)]; });
    geoPts._w = (maxX - minX) / (maxY - minY);
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var t = document.createElement("span"); t.className = "tile"; t.dataset.geoid = r.geoid; t.setAttribute("aria-hidden", "true");
      tiles.push(t); frag.appendChild(t);
    });
    stage.appendChild(frag);
    $("mc-loading").hidden = true;
    paint(); layout(true);
    stage.classList.add("live");
    wireTiles();
    // After the squares ripple in, fly them onto the map once to show the trick.
    if (!reduce) autoTimer = setTimeout(function () { if (!touched) setMode("geo"); }, 2600);
  }

  function paint() {
    var key = score + "_score", br = classes(key);
    tiles.forEach(function (t) { var r = byId[t.dataset.geoid]; t.style.backgroundColor = colorFor(r ? r[key] : null, br); });
    stage.setAttribute("aria-label", "564 squares, one per New Jersey municipality, colored by " + score + " affordability" + (mode === "grid" ? " and sorted from most to least affordable" : " and placed at each town's location"));
  }

  function layout(first) {
    if (!tiles.length) return;
    var W = stage.clientWidth, key = score + "_score";
    var s = W > 900 ? 15 : W > 640 ? 12 : W > 420 ? 9 : 7, g = Math.max(2, Math.round(s * 0.3));
    var cols = Math.max(10, Math.floor((W + g) / (s + g))), nrows = Math.ceil(tiles.length / cols);
    var gridW = cols * (s + g) - g, gridH = nrows * (s + g) - g, ox = (W - gridW) / 2;
    var order = tiles.slice().sort(function (a, b) {
      var va = byId[a.dataset.geoid][key], vb = byId[b.dataset.geoid][key];
      if (!has(va) && !has(vb)) return 0; if (!has(va)) return 1; if (!has(vb)) return -1; return vb - va;
    });
    var geoH = Math.min(560, Math.max(320, W * 0.9)), geoW = geoH * geoPts._w, gx0 = (W - geoW) / 2, sg = Math.max(5, Math.round(s * 0.8)), k = sg / s;
    stage.style.height = (mode === "grid" ? gridH : geoH + sg) + "px";
    order.forEach(function (t, i) {
      var p = geoPts[t.dataset.geoid] || [0.5, 0.5];
      var x, y, sc = 1, d;
      if (mode === "grid") { x = ox + (i % cols) * (s + g); y = Math.floor(i / cols) * (s + g); d = (i % cols) * 6 + Math.floor(i / cols) * 22; }
      else { x = gx0 + p[0] * geoH; y = p[1] * geoH; sc = k; d = p[1] * 700 + p[0] * 200; }
      t.style.width = t.style.height = s + "px";
      t.style.borderRadius = Math.round(s * 0.28) + "px";
      t.style.setProperty("--d", reduce ? "0ms" : (first ? i * 2.2 : d) + "ms");
      t.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) scale(" + sc + ")";
    });
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tiles-card [data-mode]').forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === m)); });
    stage.classList.toggle("geo", m === "geo");
    layout(false); paint();
  }

  function readout(r) {
    var el = $("mc-read");
    if (!r) { el.textContent = "Each square is one New Jersey municipality. Hover one."; return; }
    var key = score + "_score", rank = score + "_rank", n = rows.filter(function (x) { return has(x[key]); }).length;
    var label = score === "ownership" ? "Owning" : "Renting";
    el.innerHTML = "<b>" + esc(r.name) + "</b> · " + esc(r.county) + " County · " +
      (has(r[key]) ? label + " score " + Number(r[key]).toFixed(1) + ", rank " + r[rank] + " of " + n : label + " score unavailable");
  }

  function wireTiles() {
    var last = null;
    stage.addEventListener("mouseover", function (e) {
      var t = e.target.closest(".tile"); if (!t || t === last) return;
      if (last) last.classList.remove("on");
      last = t; t.classList.add("on"); stage.classList.add("dim"); readout(byId[t.dataset.geoid]);
    });
    stage.addEventListener("mouseleave", function () { if (last) last.classList.remove("on"); last = null; stage.classList.remove("dim"); readout(null); });
    stage.addEventListener("click", function (e) { var t = e.target.closest(".tile"); if (t) location.href = "map.html#town=" + t.dataset.geoid; });
    document.querySelectorAll(".tiles-card [data-mode]").forEach(function (b) {
      b.addEventListener("click", function () { touched = true; clearTimeout(autoTimer); setMode(b.dataset.mode); });
    });
    document.querySelectorAll(".tiles-card [data-score]").forEach(function (b) {
      b.addEventListener("click", function () {
        touched = true; clearTimeout(autoTimer); score = b.dataset.score;
        document.querySelectorAll(".tiles-card [data-score]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        paint(); layout(false); if (last) readout(byId[last.dataset.geoid]);
      });
    });
    var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { layout(false); }, 120); });
  }
})();
