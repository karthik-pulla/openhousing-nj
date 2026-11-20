/* Shared script for the text pages (landing, methodology, sources, data, dictionary):
   theme toggle, last-updated date and required notices from the data manifest,
   the source list on the sources page, and the town grid and figures on the landing page. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); };
  var fmt = function (iso) { var d = new Date(iso); return isNaN(d) ? (iso || "") : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); };

  var tb = $("theme-btn");
  if (tb) tb.addEventListener("click", function () {
    var t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("oh-theme", t); } catch (e) {}
    if (paintDots) paintDots();
  });
  var paintDots = null;

  // ---------------------------------------------------------------- figure count-up (landing page)
  // A figure is written with putNum(el, text). When it scrolls into view it counts up from zero
  // to its value, keeping the same format ($, commas, decimals, %). The final text is always
  // the real value. Reduced motion -> no animation.
  var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var decode = function (el) {
    var target = el.dataset.final, m = /^([^0-9]*)([0-9][0-9,]*(?:\.[0-9]+)?)(.*)$/.exec(target);
    if (!m) { el.textContent = target; return; }
    var pre = m[1], num = m[2], post = m[3], dec = (num.split(".")[1] || "").length, commas = num.indexOf(",") >= 0;
    var to = parseFloat(num.replace(/,/g, "")), dur = 1100, t0 = null;
    var show = function (v) {
      var str = v.toFixed(dec);
      if (commas) { var parts = str.split("."); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); str = parts.join("."); }
      el.textContent = pre + str + post;
    };
    var frame = function (now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      show(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(frame); else el.textContent = target;
    };
    requestAnimationFrame(frame);
  };
  var numIO = !calm && "IntersectionObserver" in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.dataset.seen = "1"; numIO.unobserve(e.target);
      if (e.target.dataset.final) decode(e.target);
    });
  }, { threshold: 0.6 }) : null;
  var putNum = function (el, text) {
    if (!el) return;
    text = String(text);
    if (!numIO || !/[0-9]/.test(text)) { el.textContent = text; return; }
    el.dataset.final = text;
    if (el.dataset.seen) decode(el);
  };
  if (numIO) document.querySelectorAll("[data-m], [data-kpi]").forEach(function (el) { numIO.observe(el); });

  // What each published source is used for, and how it may be used.
  var SOURCES = {
    acs_municipal: { name: "U.S. Census Bureau, American Community Survey (5-year)", status: "used",
      use: "Town and county median household income, median home value, median rent, renter cost burden, households and population, each with its margin of error.",
      terms: "U.S. government data, public domain." },
    acs_home_value_history: { name: "U.S. Census Bureau, ACS 5-year median home value, every release", status: "used",
      use: "The home value graph on each town profile (table B25077, releases since 2005–2009).",
      terms: "U.S. government data, public domain." },
    property_tax_municipal: { name: "NJ Department of Community Affairs, Property Tax Tables", status: "used",
      use: "The average residential property tax bill in each town (before credits and deductions).",
      terms: "New Jersey public government data." },
    hud_county: { name: "U.S. Department of Housing and Urban Development, HUD USER API", status: "used",
      use: "Income limits (80% of area median income, 4-person household) and Fair Market Rents by county.",
      terms: "Free to display with the required notice below." },
    fred_mortgage30: { name: "Freddie Mac Primary Mortgage Market Survey, via FRED", status: "used",
      use: "The 30-year fixed mortgage rate used to estimate the cost of owning (average of the latest four weeks).",
      terms: "Copyrighted by Freddie Mac; may be used with attribution. FRED notice required." },
    nzlud_municipal: { name: "National Zoning and Land Use Database (Eviction Lab, Princeton University)", status: "used",
      use: "Zoning restrictiveness for the 105 New Jersey towns it covers. Shown as context; never part of a score.",
      terms: "Published openly by the authors; cited below. The repository license covers its code; data terms are not stated." },
    fourth_round_municipal: { name: "NJ Department of Community Affairs, Fourth Round obligations (October 2024)", status: "used",
      use: "Each town's present and prospective affordable-housing need, and Qualified Urban Aid status. Shown as context; never part of a score.",
      terms: "New Jersey public government document. These are the state's calculated numbers, not records of homes built." },
    zillow_municipal: { name: "Zillow Home Value Index", status: "used",
      use: "Current typical home values where Zillow covers a town.", terms: "Zillow Research data, with Zillow's attribution." }
  };
  var EXTRA = [
    { name: "NJOGIS, New Jersey Municipal Boundaries", status: "used", period: "Current",
      use: "Town boundaries on the map, and the link between New Jersey's municipal codes and Census IDs.",
      terms: "New Jersey open data.", url: "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipal_Boundaries_3424/FeatureServer/0" },
    { name: "U.S. Census Bureau, 2020 Census (place parts)", status: "match", period: "2020",
      use: "Only used to match place names in other datasets (for example unincorporated communities) to the right municipality.",
      terms: "Public domain.", url: "https://api.census.gov/data/2020/dec/dhc" },
    { name: "U.S. Geological Survey, Geographic Names Information System", status: "match", period: "Current",
      use: "Only used as evidence when hand-checking how a place name maps to a municipality.",
      terms: "Public domain.", url: "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/" },
    { name: "Zillow Home Value Index", status: "not", period: "Not in the published data",
      use: "Downloaded and matched to towns each month, but not shown until Zillow confirms its terms allow republishing. Home values come from the Census meanwhile.",
      terms: "Awaiting confirmation from Zillow.", url: "https://www.zillow.com/research/data/", onlyIfAbsent: "zillow_municipal" },
    { name: "Redfin Data Center", status: "not", period: "Not used",
      use: "Not used. Redfin's terms of use do not allow redistributing its data.",
      terms: "Not permitted without Redfin's written permission.", url: "https://www.redfin.com/news/data-center/" }
  ];
  var STATUS = { used: "Used", match: "Matching only", not: "Not used" };

  fetch("../data/manifest.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (m) {
    document.querySelectorAll("[data-updated]").forEach(function (el) { el.textContent = "Data last updated " + fmt(m.published_at) + "."; });
    var notes = m.sources.map(function (s) { return s.attribution || ""; }).filter(function (x) { return /not endorsed/.test(x); })
      .map(function (x) { var i = x.indexOf("This product uses"); return i >= 0 ? x.slice(i) : x; });
    var n = $("notices"); if (n) n.textContent = notes.join(" ") + " Map data © Mapbox © OpenStreetMap.";

    putNum(document.querySelector('[data-kpi="sources"]'), m.sources.length);
    var vin = {}; m.sources.forEach(function (x) { vin[x.name] = x.vintage || ""; });
    var setS = function (k, t) { if (t) document.querySelectorAll('[data-ms="' + k + '"]').forEach(function (el) { el.textContent = t; }); };
    var acs = /(\d{4})-(\d{4})/.exec(vin.acs_municipal || ""); if (acs) setS("acs", "Census ACS " + acs[1] + "–" + acs[2]);
    var ty = /tax year (\d{4})/.exec(vin.property_tax_municipal || ""); if (ty) setS("tax", "NJ DCA, tax year " + ty[1]);
    var rt = /to (\d{4}-\d{2}-\d{2})/.exec(vin.fred_mortgage30 || ""); if (rt) setS("rate", "Freddie Mac, 4-week average to " + fmt(rt[1] + "T12:00:00"));
    var body = $("sources-body"); if (!body) return;
    var have = {}; m.sources.forEach(function (s) { have[s.name] = s; });
    var card = function (o) {
      return '<section class="src"><h3>' + esc(o.name) + '<span class="badge-s ' + o.status + '">' + STATUS[o.status] + "</span></h3><dl>" +
        "<dt>Used for</dt><dd>" + esc(o.use) + "</dd>" +
        "<dt>Data period</dt><dd>" + esc(o.period) + "</dd>" +
        (o.fetched ? "<dt>Retrieved</dt><dd>" + esc(o.fetched) + "</dd>" : "") +
        "<dt>Terms</dt><dd>" + esc(o.terms) + "</dd>" +
        (o.url ? '<dt>Link</dt><dd><a href="' + esc(o.url) + '">' + esc(o.url.replace(/^https?:\/\//, "").replace(/\/$/, "")) + "</a></dd>" : "") +
        "</dl>" + (o.attribution ? '<p class="q">' + esc(o.attribution) + "</p>" : "") + "</section>";
    };
    var html = "";
    Object.keys(SOURCES).forEach(function (k) {
      var s = have[k]; if (!s) return;
      var url = /^https?:/.test(s.url || "") ? s.url : (k === "fourth_round_municipal" ? "../data/static/fourth_round/FourthRoundCalculation_Methodology.pdf" : "");
      html += card({ name: SOURCES[k].name, status: SOURCES[k].status, use: SOURCES[k].use, terms: SOURCES[k].terms,
                     period: s.vintage, fetched: fmt(s.fetched_at || s.fetched), url: url, attribution: s.attribution });
    });
    EXTRA.forEach(function (o) { if (o.onlyIfAbsent && have[o.onlyIfAbsent]) return; html += card(o); });
    body.innerHTML = html;
  }).catch(function () {
    var body = $("sources-body"); if (body) body.innerHTML = "<p>The source list couldn't be loaded. See <code>data/manifest.json</code> in the repository.</p>";
  });
  // ---------------------------------------------------------------- data page: releases + citation
  var njDate = function (iso) {
    try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); } catch (e) { return String(iso).slice(0, 10); }
  };
  var rel = $("releases");
  if (rel || document.querySelector("[data-release]")) {
    fetch("../data/archive/index.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (A) {
      var list = A.releases || [];
      if (list[0]) document.querySelectorAll("[data-release]").forEach(function (el) { el.textContent = list[0].release; });
      if (!rel) return;
      rel.innerHTML = '<table class="st" aria-label="Archived releases"><thead><tr><th>Release</th><th>What changed</th><th>File</th></tr></thead><tbody>' +
        list.map(function (e) {
          var c = e.changes, what;
          if (!c) what = "First archived release.";
          else {
            var src = Object.keys(c.sources_updated || {});
            what = (src.length ? "New data: " + src.map(function (k) { return esc(k.replace(/_/g, " ")) + " (" + esc(c.sources_updated[k].to || "") + ")"; }).join(", ") + ". " : "No source changed its data period. ") +
              esc(c.ownership_rank_changed + " ownership and " + c.rental_rank_changed + " rental ranks changed (" +
                  c.ownership_rank_moved_10plus + " and " + c.rental_rank_moved_10plus + " by 10+ places).");
          }
          return "<tr><td>" + esc(e.release) + "</td><td>" + what + '</td><td><a href="../' + esc(e.csv) + '" download>CSV (gzip)</a> · <a href="../' + esc(e.manifest) + '">manifest</a></td></tr>';
        }).join("") + "</tbody></table>";
    }).catch(function () { if (rel) rel.innerHTML = '<p class="muted">The release list couldn’t be loaded. See <code>data/archive/</code> in the repository.</p>'; });
  }

  // ---------------------------------------------------------------- dictionary page
  var dict = $("dict-body");
  if (dict || document.querySelector("[data-ncols]")) {
    fetch("../data/published/data_dictionary.web.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (D) {
      var cols = D.columns || [];
      document.querySelectorAll("[data-ncols]").forEach(function (el) { el.textContent = cols.length; });
      if (!dict) return;
      var draw = function (q) {
        q = (q || "").trim().toLowerCase();
        var groups = [], by = {};
        cols.filter(function (c) {
          return !q || [c.column, c.label, c.description, c.source, c.group].join(" ").toLowerCase().indexOf(q) >= 0;
        }).forEach(function (c) { if (!by[c.group]) { by[c.group] = []; groups.push(c.group); } by[c.group].push(c); });
        dict.innerHTML = groups.length ? groups.map(function (g) {
          return "<h2>" + esc(g) + '</h2><table class="st dict" aria-label="' + esc(g) + ' columns"><thead><tr><th>Column</th><th>Meaning</th><th>Unit</th><th>Source</th></tr></thead><tbody>' +
            by[g].map(function (c) {
              return '<tr id="col-' + esc(c.column) + '"><td><code>' + esc(c.column) + "</code></td><td><b>" + esc(c.label) + "</b><br>" + esc(c.description) +
                "</td><td>" + esc(c.unit) + "</td><td>" + esc(c.source) + "</td></tr>";
            }).join("") + "</tbody></table>";
        }).join("") : '<p class="muted">No column matches.</p>';
      };
      draw("");
      var qi = $("dict-q"); if (qi) qi.addEventListener("input", function () { draw(qi.value); });
    }).catch(function () { if (dict) dict.innerHTML = '<p class="muted">The dictionary couldn’t be loaded. See <code>data/published/data_dictionary.csv</code>.</p>'; });
  }

  // ---------------------------------------------------------------- landing page
  // One square per municipality, coloured by its published score with the same
  // six equal-count groups and colours as the map. No score -> the "not enough data" colour.
  var dots = $("dots");
  if (dots) {
    var DIV = {
      light: ["#892b2a", "#d75853", "#ea9a93", "#86b6ef", "#3987e5", "#184f95"],
      dark:  ["#f1aea8", "#d75853", "#9e3432", "#1c5cab", "#3987e5", "#9ec5f4"]
    };
    var rows = [], key = "ownership_score";
    var has = function (v) { return v !== null && v !== undefined && v !== "" && !isNaN(v); };
    var pal = function () { return DIV[document.documentElement.dataset.theme === "dark" ? "dark" : "light"]; };
    var ramp = $("ramp");
    var drawRamp = function () { ramp.innerHTML = pal().map(function (c) { return '<i style="background:' + c + '"></i>'; }).join(""); };
    drawRamp();

    // The squares show the spread of scores; hovering one shows which town it is (they don't link anywhere).
    var order = [];
    var render = function () {
      order = rows.slice().sort(function (a, b) {
        var x = a[key], y = b[key];
        if (!has(x) && !has(y)) return a.name < b.name ? -1 : 1;
        if (!has(x)) return 1; if (!has(y)) return -1;
        return y - x;
      });
      var scored = order.filter(function (r) { return has(r[key]); }).length;
      dots.innerHTML = order.map(function (r, j) { return '<i data-j="' + j + '"></i>'; }).join("");
      dots.setAttribute("aria-label", order.length + " New Jersey municipalities; " + scored + " have a" +
        (key === "rental_score" ? " rental" : "n ownership") + " score and " + (order.length - scored) + " don't have enough data.");
      paintDots();
    };
    paintDots = function () {
      drawRamp();
      var asc = rows.map(function (r) { return r[key]; }).filter(has).map(Number).sort(function (a, b) { return a - b; });
      var breaks = []; for (var i = 1; i < 6; i++) breaks.push(asc[Math.min(asc.length - 1, Math.floor(i * asc.length / 6))]);
      var p = pal();
      dots.querySelectorAll("i").forEach(function (el, j) {
        var v = order[j] && order[j][key];
        if (!has(v)) { el.style.backgroundColor = ""; return; }
        var c = 0; while (c < breaks.length && Number(v) >= breaks[c]) c++;
        el.style.backgroundColor = p[c];
      });
    };

    var tip = $("dot-tip"), wrap = dots.parentNode, hot = null;
    var hideTip = function () { tip.style.display = "none"; if (hot) hot.classList.remove("hot"); hot = null; };
    var showTip = function (el) {
      var r = order[+el.dataset.j]; if (!r) return;
      if (hot) hot.classList.remove("hot"); hot = el; el.classList.add("hot");
      var v = r[key], label = key === "rental_score" ? "Rental" : "Ownership";
      tip.innerHTML = "<b>" + esc(r.name) + "</b><span>" + esc(r.county) + " County</span><span>" +
        (has(v) ? label + " score " + Number(v).toFixed(1) : "Not enough data for a " + label.toLowerCase() + " score") + "</span>";
      tip.style.display = "block";
      var wr = wrap.getBoundingClientRect(), ar = el.getBoundingClientRect();
      var x = ar.left - wr.left + ar.width / 2 - tip.offsetWidth / 2;
      var y = ar.top - wr.top - tip.offsetHeight - 8;
      tip.style.left = Math.max(6, Math.min(wr.width - tip.offsetWidth - 6, x)) + "px";
      tip.style.top = (y < 4 ? ar.bottom - wr.top + 8 : y) + "px";
    };
    dots.addEventListener("mouseover", function (e) { if (e.target.dataset && e.target.dataset.j) showTip(e.target); });
    dots.addEventListener("mouseleave", hideTip);
    // Touch: tap a square to see its name, tap outside to close.
    dots.addEventListener("click", function (e) { if (e.target.dataset && e.target.dataset.j) showTip(e.target); });
    document.addEventListener("click", function (e) { if (!dots.contains(e.target)) hideTip(); });

    document.querySelectorAll(".seg [data-score]").forEach(function (b) {
      b.addEventListener("click", function () {
        key = b.dataset.score; hideTip();
        document.querySelectorAll(".seg [data-score]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        if (rows.length) render();
      });
    });

    // "At a glance" figures: middle value across municipalities, from the published file.
    var median = function (c) {
      var v = rows.map(function (r) { return r[c]; }).filter(has).map(Number).sort(function (a, b) { return a - b; });
      if (!v.length) return null;
      var h = Math.floor(v.length / 2); return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
    };
    var usd = function (x, step) { return x === null ? "–" : "$" + (Math.round(x / step) * step).toLocaleString("en-US"); };
    var pct = function (x) { return x === null ? "–" : Math.round(x * 100) + "%"; };
    var setM = function (k, v) { putNum(document.querySelector('[data-m="' + k + '"]'), v); };

    fetch("../data/published/openhousing_nj.web.json").then(function (r) { return r.json(); }).then(function (d) {
      var ix = {}; d.columns.forEach(function (c, i) { ix[c] = i; });
      var pick = ["name", "county", "ownership_score", "rental_score", "home_value", "annual_ownership_cost", "ownership_burden", "rent_burden",
                  "avg_property_tax_bill", "mortgage_rate_pct", "ownership_affordable_at_ami80", "renters_cost_burdened_share"];
      rows = d.data.map(function (a) { var o = {}; pick.forEach(function (c) { o[c] = a[ix[c]]; }); return o; });
      var count = function (c) { return rows.filter(function (x) { return has(x[c]); }).length; };
      var set = function (k, v) { putNum(document.querySelector('[data-kpi="' + k + '"]'), v); };
      set("towns", rows.length); set("own", count("ownership_score")); set("rent", count("rental_score"));

      setM("home_value", usd(median("home_value"), 100));
      setM("own_cost", usd(median("annual_ownership_cost"), 100));
      setM("own_burden", pct(median("ownership_burden")));
      setM("rent_burden", pct(median("rent_burden")));
      setM("tax", usd(median("avg_property_tax_bill"), 10));
      var rate = median("mortgage_rate_pct"); setM("rate", rate === null ? "–" : rate.toFixed(2) + "%");
      var known = rows.filter(function (r) { return r.ownership_affordable_at_ami80 === true || r.ownership_affordable_at_ami80 === false; });
      var out = known.filter(function (r) { return r.ownership_affordable_at_ami80 === false; }).length;
      setM("ami_out", known.length ? pct(out / known.length) : "–");
      var s2 = document.querySelector('[data-m2="ami_out_n"]');
      if (s2 && known.length) s2.textContent = out + " of " + known.length + " towns, for a family of four at 80% of area median income";
      setM("cost_burdened", pct(median("renters_cost_burdened_share")));
      render();
    }).catch(function () { dots.setAttribute("aria-label", "The town grid couldn't be loaded."); });

    // Gentle fade-in as sections scroll into view.
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
      }, { threshold: 0.12 });
      document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });
    } else {
      document.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("in"); });
    }
  }
})();
