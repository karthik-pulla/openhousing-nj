/* OpenHousing NJ landing page. Calm by design: no auto-playing animation.
   Every number shown is computed from the published files. */
(function () {
  "use strict";
  var P = { data: "../data/published/openhousing_nj.web.json", manifest: "../data/manifest.json",
            bounds: "data/boundaries.geojson" };
  // Same diverging affordability colors as the map: reds below the NJ median, blues above it.
  var DIV = { light: ["#892b2a", "#d75853", "#ea9a93", "#86b6ef", "#3987e5", "#184f95"],
              dark:  ["#f1aea8", "#d75853", "#9e3432", "#1c5cab", "#3987e5", "#9ec5f4"] };
  var $ = function (id) { return document.getElementById(id); };
  var has = function (v) { return v !== null && v !== undefined && !(typeof v === "number" && isNaN(v)); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var isDark = function () { return document.documentElement.dataset.theme === "dark"; };
  var rows = [], byId = {}, score = "ownership", mode = "grid", tiles = [], geo = {};
  var stage = $("stage");

  // header border once scrolled; theme
  var top = $("top");
  var onScroll = function () { top.classList.toggle("scrolled", window.scrollY > 4); };
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  $("theme-btn").addEventListener("click", function () {
    var t = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("oh-theme", t); } catch (e) {}
    paint(); fillLists();
  });

  function get(u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  Promise.all([get(P.data), get(P.manifest)]).then(function (res) {
    var split = res[0], m = res[1];
    rows = split.data.map(function (a) { var o = {}; split.columns.forEach(function (c, i) { o[c] = a[i]; }); o.geoid = String(o.geoid); return o; });
    rows.forEach(function (r) { byId[r.geoid] = r; });
    var d = new Date(m.published_at);
    $("meta").textContent = rows.length + " municipalities · data updated " + (isNaN(d) ? m.published_at : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
    fillLists(); fillSources(m);
    return get(P.bounds).then(buildTiles);
  }).catch(function () { $("readout").textContent = "The preview couldn't load. Open the map instead."; });

  // ------------------------------------------------------------ colors
  function breaks(key) {
    var v = rows.map(function (r) { return r[key]; }).filter(has).sort(function (a, b) { return a - b; });
    var br = []; for (var i = 1; i < 6; i++) br.push(v[Math.floor(i * v.length / 6)]);   // 6 groups, split at the median
    return br;
  }
  function colorFor(val, br) {
    if (!has(val)) return getComputedStyle(document.documentElement).getPropertyValue("--nodata").trim();
    var i = 0; while (i < br.length && val >= br[i]) i++;
    return DIV[isDark() ? "dark" : "light"][i];
  }

  // ------------------------------------------------------------ top / bottom lists
  function fillLists() {
    if (!rows.length) return;
    var make = function (key, rank, el, best) {
      var br = breaks(key), scored = rows.filter(function (r) { return has(r[key]); }).sort(function (a, b) { return a[rank] - b[rank]; });
      var pick = best ? scored.slice(0, 3) : scored.slice(-3).reverse();
      $(el).innerHTML = pick.map(function (r) {
        return '<li><a href="map.html#town=' + r.geoid + '"><i class="dot" style="background:' + colorFor(r[key], br) + '" aria-hidden="true"></i>' +
          '<span class="t">' + esc(r.name) + "<small>" + esc(r.county) + " County · rank " + r[rank] + " of " + scored.length + "</small></span>" +
          '<span class="s">' + Number(r[key]).toFixed(1) + "</span></a></li>";
      }).join("");
    };
    make("ownership_score", "ownership_rank", "own-best", true);
    make("ownership_score", "ownership_rank", "own-worst", false);
    make("rental_score", "rental_rank", "rent-best", true);
    make("rental_score", "rental_rank", "rent-worst", false);
  }

  function fillSources(m) {
    var labels = { acs_municipal: "U.S. Census Bureau, American Community Survey", property_tax_municipal: "NJ Dept. of Community Affairs, property taxes",
      hud_county: "HUD income limits and Fair Market Rents", fred_mortgage30: "Freddie Mac 30-year mortgage rate", nzlud_municipal: "Zoning (NZLUD, Eviction Lab)",
      fourth_round_municipal: "NJ Dept. of Community Affairs, Fourth Round obligations", zillow_municipal: "Zillow Home Value Index" };
    $("sources-list").innerHTML = m.sources.filter(function (s) { return labels[s.name]; }).map(function (s) {
      return "<li>" + esc(labels[s.name]) + "<span>" + esc(s.vintage) + "</span></li>";
    }).join("") + "<li>NJOGIS municipal boundaries<span>Current</span></li>";
    $("notices").textContent = m.sources.map(function (s) { return s.attribution || ""; }).filter(function (x) { return /not endorsed/.test(x); })
      .map(function (x) { var i = x.indexOf("This product uses"); return i >= 0 ? x.slice(i) : x; }).join(" ") + " Map data © Mapbox © OpenStreetMap.";
  }

  // ------------------------------------------------------------ tile board
  // One square per municipality. "Ranked" sorts most -> least affordable (no data last);
  // "On the map" places each square at its town's location. Changes animate only when you ask.
  function buildTiles(gj) {
    var kx = Math.cos(40.1 * Math.PI / 180), minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, raw = {};
    gj.features.forEach(function (f) {
      var polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates, sx = 0, sy = 0, n = 0;
      polys.forEach(function (p) { p[0].forEach(function (c) { sx += c[0] * kx; sy -= c[1]; n++; }); });
      var x = sx / n, y = sy / n; raw[f.properties.geoid] = [x, y];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    var span = maxY - minY;
    Object.keys(raw).forEach(function (g) { geo[g] = [(raw[g][0] - minX) / span, (raw[g][1] - minY) / span]; });
    geo._w = (maxX - minX) / span;
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var t = document.createElement("span"); t.className = "tile"; t.dataset.geoid = r.geoid; t.setAttribute("aria-hidden", "true");
      tiles.push(t); frag.appendChild(t);
    });
    stage.appendChild(frag);
    paint(); layout();
    requestAnimationFrame(function () {
      stage.classList.add("ready");
      requestAnimationFrame(function () { stage.classList.add("anim"); });   // enable sliding only now
    });
    wire();
  }

  function paint() {
    if (!tiles.length) return;
    var key = score + "_score", br = breaks(key);
    tiles.forEach(function (t) { var r = byId[t.dataset.geoid]; t.style.backgroundColor = colorFor(r ? r[key] : null, br); });
    stage.setAttribute("aria-label", "564 squares, one per New Jersey municipality, colored by " + score + " affordability" +
      (mode === "grid" ? ", sorted from most to least affordable" : ", placed at each town's location"));
  }

  function layout() {
    if (!tiles.length) return;
    var W = stage.clientWidth, key = score + "_score";
    var s = W > 900 ? 14 : W > 640 ? 12 : W > 420 ? 9 : 8, g = Math.max(2, Math.round(s * 0.3));
    var cols = Math.max(10, Math.floor((W + g) / (s + g))), nrows = Math.ceil(tiles.length / cols);
    var gridW = cols * (s + g) - g, gridH = nrows * (s + g) - g, ox = (W - gridW) / 2;
    var order = tiles.slice().sort(function (a, b) {
      var va = byId[a.dataset.geoid][key], vb = byId[b.dataset.geoid][key];
      if (!has(va) && !has(vb)) return 0; if (!has(va)) return 1; if (!has(vb)) return -1; return vb - va;
    });
    var geoH = Math.min(520, Math.max(300, W * 0.85)), geoW = geoH * geo._w, gx0 = (W - geoW) / 2, k = Math.max(5, Math.round(s * 0.8)) / s;
    stage.style.height = (mode === "grid" ? gridH : geoH + s) + "px";
    order.forEach(function (t, i) {
      var p = geo[t.dataset.geoid] || [0.5, 0.5], x, y, sc = 1;
      if (mode === "grid") { x = ox + (i % cols) * (s + g); y = Math.floor(i / cols) * (s + g); }
      else { x = gx0 + p[0] * geoH; y = p[1] * geoH; sc = k; }
      t.style.width = t.style.height = s + "px";
      t.style.borderRadius = Math.round(s * 0.28) + "px";
      t.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) scale(" + sc + ")";
    });
  }

  function readout(r) {
    var el = $("readout");
    if (!r) { el.textContent = "Each square is one municipality. Hover or tap one; select it to open its profile."; return; }
    var key = score + "_score", rank = score + "_rank", n = rows.filter(function (x) { return has(x[key]); }).length;
    var label = score === "ownership" ? "Owning" : "Renting";
    el.innerHTML = "<b>" + esc(r.name) + "</b> · " + esc(r.county) + " County · " +
      (has(r[key]) ? label + " score " + Number(r[key]).toFixed(1) + " (rank " + r[rank] + " of " + n + ")" : label + " score unavailable");
  }

  function wire() {
    var last = null;
    var pick = function (t) {
      if (last) last.classList.remove("on");
      last = t; if (t) { t.classList.add("on"); stage.classList.add("dim"); readout(byId[t.dataset.geoid]); }
      else { stage.classList.remove("dim"); readout(null); }
    };
    stage.addEventListener("mouseover", function (e) { var t = e.target.closest(".tile"); if (t && t !== last) pick(t); });
    stage.addEventListener("mouseleave", function () { pick(null); });
    stage.addEventListener("click", function (e) {
      var t = e.target.closest(".tile"); if (!t) return;
      // touch: first tap shows the town, second tap opens it
      if (window.matchMedia("(hover: none)").matches && t !== last) { pick(t); return; }
      location.href = "map.html#town=" + t.dataset.geoid;
    });
    document.querySelectorAll(".board [data-score]").forEach(function (b) {
      b.addEventListener("click", function () {
        score = b.dataset.score;
        document.querySelectorAll(".board [data-score]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        paint(); layout(); if (last) readout(byId[last.dataset.geoid]);
      });
    });
    document.querySelectorAll(".board [data-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        mode = b.dataset.mode;
        document.querySelectorAll(".board [data-mode]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        layout(); paint();
      });
    });
    var rt; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(layout, 120); });
  }
})();
