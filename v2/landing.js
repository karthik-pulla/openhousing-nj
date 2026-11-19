/* OpenHousing NJ landing page. Every number shown is computed from the published files. */
(function () {
  "use strict";
  var P = { data: "../data/published/openhousing_nj.web.json", manifest: "../data/manifest.json",
            meta: "../data/published/index_meta.json", bounds: "data/boundaries.geojson" };
  var BLUE = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0d366b"];
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
    paint(false);
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

  // ------------------------------------------------------------ data
  function get(u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  Promise.all([get(P.data), get(P.manifest), get(P.meta)]).then(function (res) {
    var split = res[0], m = res[1], meta = res[2];
    rows = split.data.map(function (a) { var o = {}; split.columns.forEach(function (c, i) { o[c] = a[i]; }); o.geoid = String(o.geoid); return o; });
    rows.forEach(function (r) { byId[r.geoid] = r; });
    fillCopy(m, meta);
    fillMarkets();
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
    var statSrc = document.querySelector('.stat b[data-count="7"]');
    if (statSrc) setCount(statSrc, nSources);
    setCount($("b-prosp"), rows.reduce(function (s, r) { return s + (has(r.prospective_need_capped) ? r.prospective_need_capped : 0); }, 0));
    setCount($("b-qua"), rows.filter(function (r) { return r.qualified_urban_aid === true || r.qualified_urban_aid === "True"; }).length);
    setCount($("b-zri"), rows.filter(function (r) { return has(r.zri); }).length);
    $("updated-line").textContent = "Current data published " + when + ". Missing data is shown as missing; nothing is estimated or filled in.";
    var labels = { acs_municipal: "U.S. Census Bureau · ACS", acs_county: null, property_tax_municipal: "NJ DCA · Property Tax Tables",
      hud_county: "HUD · Income Limits & Fair Market Rents", fred_mortgage30: "Freddie Mac PMMS · via FRED", nzlud_municipal: "NZLUD · Eviction Lab",
      fourth_round_municipal: "NJ DCA · Fourth Round obligations", zillow_municipal: "Zillow · Home Value Index" };
    $("source-pills").innerHTML = m.sources.filter(function (s) { return labels[s.name] !== null; }).map(function (s) {
      return "<li><b>" + esc(labels[s.name] || s.source) + "</b><span>" + esc(s.vintage) + "</span></li>";
    }).join("") + "<li><b>NJOGIS · Municipal Boundaries</b><span>Current</span></li>";
    var notes = m.sources.map(function (s) { return s.attribution || ""; }).filter(function (x) { return /not endorsed/.test(x); })
      .map(function (x) { var i = x.indexOf("This product uses"); return i >= 0 ? x.slice(i) : x; });
    $("foot-notices").textContent = notes.join(" ") + " Map data © Mapbox © OpenStreetMap.";
  }

  function fillMarkets() {
    var mk = function (key, rank, el, best) {
      var scored = rows.filter(function (r) { return has(r[key]); }).sort(function (a, b) { return a[rank] - b[rank]; });
      var pick = best ? scored.slice(0, 3) : scored.slice(-3).reverse();
      $(el).innerHTML = pick.map(function (r) {
        return '<li><a href="map.html#town=' + r.geoid + '"><span class="t">' + esc(r.name) + "<small>" + esc(r.county) + " County · " + ordinal(r[rank]) + " of " + scored.length +
          '</small></span><span class="s">' + Number(r[key]).toFixed(1) + "</span></a></li>";
      }).join("");
    };
    mk("ownership_score", "ownership_rank", "own-best", true);
    mk("ownership_score", "ownership_rank", "own-worst", false);
    mk("rental_score", "rental_rank", "rent-best", true);
    mk("rental_score", "rental_rank", "rent-worst", false);
  }

  // ------------------------------------------------------------ hero map
  function classes(key) {
    var v = rows.map(function (r) { return r[key]; }).filter(has).sort(function (a, b) { return a - b; });
    var br = []; for (var i = 1; i < 7; i++) br.push(v[Math.floor(i * v.length / 7)]);
    return br;
  }
  function colorFor(val, br) {
    if (!has(val)) return getComputedStyle(document.documentElement).getPropertyValue("--nodata").trim();
    var i = 0; while (i < br.length && val >= br[i]) i++;
    var r = isDark() ? BLUE.slice().reverse() : BLUE;
    return r[i];
  }

  function drawMap(gj) {
    var svg = $("njmap"), lat0 = 40.1 * Math.PI / 180, kx = Math.cos(lat0);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var polys = gj.features.map(function (f) { return f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates; });
    polys.forEach(function (mp) { mp.forEach(function (p) { p[0].forEach(function (c) {
      var x = c[0] * kx, y = -c[1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }); }); });
    var S = 600 / (maxY - minY), W = (maxX - minX) * S, H = 600;
    svg.setAttribute("viewBox", "0 0 " + W.toFixed(1) + " " + H);
    var frag = document.createDocumentFragment(), ns = "http://www.w3.org/2000/svg";
    gj.features.forEach(function (f, i) {
      var cy = 0, cx = 0, n = 0, d = "";
      polys[i].forEach(function (poly) { poly.forEach(function (ring) {
        ring.forEach(function (c, j) {
          var x = (c[0] * kx - minX) * S, y = (-c[1] - minY) * S;
          d += (j ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
          cx += x; cy += y; n++;
        });
        d += "Z";
      }); });
      var p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      p.dataset.geoid = f.properties.geoid;
      cx /= n; cy /= n;
      // North-to-south reveal with a little jitter; left-to-right sweep when switching layers.
      p.style.setProperty("--d", reduce ? "0s" : ((cy / H) * 1.3 + Math.random() * 0.25).toFixed(2) + "s");
      p.style.setProperty("--sw", reduce ? "0s" : ((cx / W) * 0.6).toFixed(2) + "s");
      paths.push(p);
      frag.appendChild(p);
    });
    svg.appendChild(frag);
    $("mc-loading").hidden = true;
    paint(true);
    wireMap(svg);
    // After the reveal, drop the animation so hover dimming (opacity) can apply.
    setTimeout(function () { svg.classList.add("ready"); }, reduce ? 0 : 2300);
  }

  function paint() {
    if (!paths.length) return;
    var key = score + "_score", br = classes(key);
    paths.forEach(function (p) { var r = byId[p.dataset.geoid]; p.style.fill = colorFor(r ? r[key] : null, br); });
    $("njmap").setAttribute("aria-label", "Map of New Jersey's 564 municipalities, colored by " + (score === "ownership" ? "ownership" : "rental") + " affordability score");
  }

  function readout(r) {
    var el = $("mc-read");
    if (!r) { el.innerHTML = '<span class="mc-k">Hover a town</span><span class="mc-v">Each shape is a municipality. Darker blue means more affordable.</span>'; return; }
    var key = score + "_score", rank = score + "_rank", n = rows.filter(function (x) { return has(x[key]); }).length;
    var label = score === "ownership" ? "Ownership" : "Rental";
    var v = has(r[key]) ? label + " score " + Number(r[key]).toFixed(1) + " · ranks " + ordinal(r[rank]) + " of " + n + " · click to open"
                        : label + " score unavailable (not enough data) · click to open";
    el.innerHTML = '<span class="mc-k">' + esc(r.name) + ', <span style="font-weight:500">' + esc(r.county) + ' County</span></span><span class="mc-v">' + esc(v) + "</span>";
  }

  function wireMap(svg) {
    var last = null;
    svg.addEventListener("mouseover", function (e) {
      var p = e.target.closest("path"); if (!p || p === last) return;
      if (last) last.classList.remove("on");
      last = p; p.classList.add("on"); p.parentNode.appendChild(p);   // bring outline to front
      svg.classList.add("dim");
      readout(byId[p.dataset.geoid]);
    });
    svg.addEventListener("mouseleave", function () { if (last) last.classList.remove("on"); last = null; svg.classList.remove("dim"); readout(null); });
    svg.addEventListener("click", function (e) { var p = e.target.closest("path"); if (p) location.href = "map.html#town=" + p.dataset.geoid; });
    document.querySelectorAll(".mapcard .segb").forEach(function (b) {
      b.addEventListener("click", function () {
        score = b.dataset.score;
        document.querySelectorAll(".mapcard .segb").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        paint(); if (last) readout(byId[last.dataset.geoid]);
      });
    });
  }
})();
