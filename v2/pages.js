/* Shared script for the text pages (landing, methodology, sources, data):
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

    var k = document.querySelector('[data-kpi="sources"]'); if (k) k.textContent = m.sources.length;
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
  // ---------------------------------------------------------------- landing page
  // One square per municipality, coloured by its published score with the same
  // six equal-count groups and colours as the map. No score -> the "not enough data" colour.
  var dots = $("dots");
  if (dots) {
    var DIV = {
      light: ["#892b2a", "#d75853", "#ea9a93", "#86b6ef", "#3987e5", "#184f95"],
      dark:  ["#f1aea8", "#d75853", "#9e3432", "#1c5cab", "#3987e5", "#9ec5f4"]
    };
    var LABEL = { ownership_score: "ownership", rental_score: "rental" };
    var RANK = { ownership_score: "ownership_rank", rental_score: "rental_rank" };
    var rows = [], key = "ownership_score";
    var has = function (v) { return v !== null && v !== undefined && v !== "" && !isNaN(v); };
    var pal = function () { return DIV[document.documentElement.dataset.theme === "dark" ? "dark" : "light"]; };
    var ramp = $("ramp");
    var drawRamp = function () { ramp.innerHTML = pal().map(function (c) { return '<i style="background:' + c + '"></i>'; }).join(""); };
    drawRamp();

    var render = function () {
      var sorted = rows.slice().sort(function (a, b) {
        var x = a[key], y = b[key];
        if (!has(x) && !has(y)) return a.name < b.name ? -1 : 1;
        if (!has(x)) return 1; if (!has(y)) return -1;
        return y - x;
      });
      dots.innerHTML = sorted.map(function (r) {
        return '<a href="map.html#town=' + r.geoid + (key === "rental_score" ? "&layer=rental_score" : "") + '" data-g="' + r.geoid + '" tabindex="-1" aria-hidden="true"></a>';
      }).join("");
      var n = rows.filter(function (r) { return has(r[key]); }).length;
      dots.setAttribute("aria-label", rows.length + " New Jersey municipalities; " + n + " have a" + (key === "rental_score" ? " rental" : "n ownership") +
        " score. Open the map to explore them, or download the data for the full list.");
      paintDots();
    };
    paintDots = function () {
      drawRamp();
      var vals = rows.map(function (r) { return r[key]; }).filter(has).map(Number).sort(function (a, b) { return a - b; });
      var breaks = []; for (var i = 1; i < 6; i++) breaks.push(vals[Math.min(vals.length - 1, Math.floor(i * vals.length / 6))]);
      var p = pal(), by = {}; rows.forEach(function (r) { by[r.geoid] = r; });
      dots.querySelectorAll("a").forEach(function (a) {
        var v = by[a.dataset.g][key];
        if (!has(v)) { a.style.backgroundColor = ""; return; }
        var c = 0; while (c < breaks.length && Number(v) >= breaks[c]) c++;
        a.style.backgroundColor = p[c];
      });
    };

    document.querySelectorAll(".seg [data-score]").forEach(function (b) {
      b.addEventListener("click", function () {
        key = b.dataset.score;
        document.querySelectorAll(".seg [data-score]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        if (rows.length) render();
      });
    });

    var tip = $("dot-tip"), wrap = dots.parentNode;
    dots.addEventListener("mouseover", function (e) {
      var a = e.target.closest("a"); if (!a) return;
      var r = rows.filter(function (x) { return x.geoid === a.dataset.g; })[0]; if (!r) return;
      var v = r[key], nScored = rows.filter(function (x) { return has(x[key]); }).length;
      tip.innerHTML = "<b>" + esc(r.name) + "</b><span>" + esc(r.county) + "</span>" +
        (has(v) ? "<span>" + (LABEL[key] === "rental" ? "Rental" : "Ownership") + " score " + Number(v).toFixed(1) +
          (has(r[RANK[key]]) ? " · rank " + r[RANK[key]] + " of " + nScored : "") + "</span>"
                : "<span>Not enough data for a " + LABEL[key] + " score</span>");
      tip.style.display = "block";
      var wr = wrap.getBoundingClientRect(), ar = a.getBoundingClientRect();
      var x = ar.left - wr.left + ar.width / 2 - tip.offsetWidth / 2;
      tip.style.left = Math.max(6, Math.min(wr.width - tip.offsetWidth - 6, x)) + "px";
      tip.style.top = (ar.top - wr.top - tip.offsetHeight - 8) + "px";
    });
    dots.addEventListener("mouseleave", function () { tip.style.display = "none"; });

    fetch("../data/published/openhousing_nj.web.json").then(function (r) { return r.json(); }).then(function (d) {
      var ix = {}; d.columns.forEach(function (c, i) { ix[c] = i; });
      var pick = ["geoid", "name", "county", "ownership_score", "ownership_rank", "rental_score", "rental_rank"];
      rows = d.data.map(function (a) { var o = {}; pick.forEach(function (c) { o[c] = a[ix[c]]; }); return o; });
      var count = function (c) { return rows.filter(function (x) { return has(x[c]); }).length; };
      var set = function (k, v) { var el = document.querySelector('[data-kpi="' + k + '"]'); if (el) el.textContent = v; };
      set("towns", rows.length); set("own", count("ownership_score")); set("rent", count("rental_score"));
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
