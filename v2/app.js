/* OpenHousing NJ v2 map app. Plain JavaScript, no build step.
 *
 * Reads only published, validated files:
 *   ../data/published/openhousing_nj.web.json     one row per municipality (same columns as the CSV)
 *   ../data/published/summaries.web.json          template summaries, each statistic tagged with its sources
 *   ../data/published/home_value_history.web.json ACS 5-year median home value by release (profile graph)
 *   ../data/manifest.json                         sources, vintages, fetch dates, publish date
 *   data/boundaries.geojson                       simplified NJOGIS boundaries, joined on geoid
 * No accounts, no tracking. localStorage holds only the theme, favorites, comparison list and hint flag.
 */
(function () {
  "use strict";

  var MAPBOX_TOKEN = "pk.eyJ1Ijoia2FydGhpa3B1bGxhIiwiYSI6ImNtcm54aTBpODA0MTIyenB6c3ZocmtvZDUifQ.lj2b4gjgCavNcMso7fcI6g";
  var PATHS = {
    data: "../data/published/openhousing_nj.web.json",
    summaries: "../data/published/summaries.web.json",
    history: "../data/published/home_value_history.web.json",
    manifest: "../data/manifest.json",
    bounds: "data/boundaries.geojson"
  };
  var NJ_BOUNDS = [[-75.6, 38.92], [-73.88, 41.36]];
  var MAX_COMPARE = 3;
  var UNAV = "Unavailable";

  // Colors. Affordability uses v1's diverging scheme: three reds below the state
  // median (less affordable), three blues above it (more affordable); both arms
  // matched in lightness. No gray middle class, so gray only ever means "not
  // enough data". Dark mode has its own steps. Barriers use one-hue violet.
  var DIV = {
    light: ["#892b2a", "#d75853", "#ea9a93", "#86b6ef", "#3987e5", "#184f95"],
    dark:  ["#f1aea8", "#d75853", "#9e3432", "#1c5cab", "#3987e5", "#9ec5f4"]
  };
  var VIOLET = { light: ["#cacbfb", "#a9a9f7", "#8a85f2", "#6f62e1", "#5549b4", "#3e3388", "#322a71"],
                 dark:  ["#322a71", "#3e3388", "#5549b4", "#6f62e1", "#8a85f2", "#a9a9f7", "#cacbfb"] };

  // ------------------------------------------------------------------ formatting
  function has(v) { return v !== null && v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v)); }
  function money(v) { if (!has(v)) return UNAV; var s = v >= 100000 ? 1000 : v >= 1000 ? 100 : 10; return "$" + (Math.round(v / s) * s).toLocaleString("en-US"); }
  function rentMoney(v) { return has(v) ? "$" + (Math.round(v / 10) * 10).toLocaleString("en-US") : UNAV; }  // rents: nearest $10
  function pct(v, d) { return has(v) ? (v * 100).toFixed(d || 0) + "%" : UNAV; }
  function num(v, d) { return has(v) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }) : UNAV; }
  function ordinal(n) { n = Math.round(n); var s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"; return n.toLocaleString("en-US") + s; }
  function isTrue(v) { return v === true || v === "True"; }
  function yesno(v) { return has(v) ? (isTrue(v) ? "Yes" : "No") : UNAV; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtDate(iso) { var d = new Date(iso); return isNaN(d) ? (iso || "") : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }

  // ------------------------------------------------------------------ layers
  // scheme "div": diverging affordability colors. invert: higher value = LESS affordable (burdens).
  var LAYERS = [
    { group: "Affordability score", key: "ownership_score", label: "Owning a home", sub: "Score 0–100 · higher is more affordable", scheme: "div",
      fmt: function (v) { return num(v, 1); }, better: "high", best: "Most affordable", worst: "Least affordable",
      rank: "ownership_rank", ends: ["Less affordable", "More affordable"],
      desc: "0–100 percentile score. Higher means owning the typical home (mortgage at today's rate plus average property tax) takes a smaller share of county median income." },
    { group: "Affordability score", key: "rental_score", label: "Renting a home", sub: "Score 0–100 · higher is more affordable", scheme: "div",
      fmt: function (v) { return num(v, 1); }, better: "high", best: "Most affordable", worst: "Least affordable",
      rank: "rental_rank", ends: ["Less affordable", "More affordable"],
      desc: "0–100 percentile score. Higher means a year of median rent takes a smaller share of county median income." },
    { group: "Cost compared with income", key: "ownership_burden", label: "Cost to own vs. income", sub: "Mortgage + property tax as a % of county income", scheme: "div", invert: true,
      fmt: function (v) { return pct(v); }, better: "low", best: "Smallest share", worst: "Largest share",
      ends: ["Larger share", "Smaller share"],
      desc: "Yearly mortgage payment on the typical home plus the average property tax bill, as a share of county median household income." },
    { group: "Cost compared with income", key: "rent_burden", label: "Rent vs. income", sub: "A year of rent as a % of county income", scheme: "div", invert: true,
      fmt: function (v) { return pct(v); }, better: "low", best: "Smallest share", worst: "Largest share",
      ends: ["Larger share", "Smaller share"],
      desc: "Twelve months of median gross rent as a share of county median household income." },
    { group: "Cost compared with income", key: "ownership_burden_ami80", label: "Cost to own for a moderate-income family", sub: "As a % of HUD's income limit for a family of four", scheme: "div", invert: true,
      fmt: function (v) { return pct(v); }, better: "low", best: "Smallest share", worst: "Largest share",
      ends: ["Larger share", "Smaller share"],
      desc: "Ownership cost as a share of HUD's low-income limit (80% of area median income) for a four-person household. 30% or less is considered affordable." },
    { group: "Cost compared with income", key: "renters_cost_burdened_share", label: "Renters stretched by rent", sub: "% of renters paying 30%+ of income · context only", scheme: "div", invert: true,
      fmt: function (v) { return pct(v); }, better: "low", best: "Smallest share", worst: "Largest share",
      ends: ["Larger share", "Smaller share"],
      desc: "Share of renter households paying 30% or more of their own income on rent. Context only: not part of either score, and unreliable in small towns." },
    { group: "Barriers · shown, not scored", key: "zri", label: "Zoning strictness", sub: "How restrictive local zoning is · 105 towns covered", scheme: "violet",
      fmt: function (v) { return num(v, 2); }, better: null, best: "Most restrictive", worst: "Least restrictive",
      ends: ["Less restrictive", "More restrictive"],
      desc: "National Zoning and Land Use Database restrictiveness index (higher = more restrictive). Covers 105 of 564 towns." },
    { group: "Barriers · shown, not scored", key: "prospective_need_per_1000_hh", label: "Future affordable homes required", sub: "State target for 2025–2035, per 1,000 households", scheme: "violet",
      fmt: function (v) { return num(v, 1); }, better: null, best: "Highest", worst: "Lowest", ends: ["Lower", "Higher"],
      desc: "Fourth Round (2025–2035) prospective need as calculated by the state in October 2024, per 1,000 households. Qualified Urban Aid towns have none by law; their 0 is not missing data." },
    { group: "Barriers · shown, not scored", key: "present_need", label: "Affordable homes needed now", sub: "State estimate of current need, in homes", scheme: "violet",
      fmt: function (v) { return num(v); }, better: null, best: "Highest", worst: "Lowest", ends: ["Lower", "Higher"],
      desc: "Fourth Round present need (deficient housing occupied by low- and moderate-income households), as calculated by the state in October 2024." },
    { group: "Barriers · shown, not scored", key: "qualified_urban_aid", label: "Exempt from future targets", sub: "Qualified Urban Aid towns (47)", scheme: "violet",
      categorical: true, fmt: yesno, better: null, best: "Yes first", worst: "No first", ends: ["No", "Yes"],
      desc: "Qualified Urban Aid municipalities (47) have no prospective need obligation under the Affordable Housing Law. They may still have a present need." }
  ];
  var LAYER_BY_KEY = {};
  LAYERS.forEach(function (l) { LAYER_BY_KEY[l.key] = l; });

  // Profile rows: [column, label, formatter, source key, help text]
  var SECTIONS = [
    { title: "Owning", rows: [
      ["home_value", "Typical home value", money, "home_value", "Median value of owner-occupied homes (owners' own estimates)."],
      ["annual_mortgage_pi", "Mortgage, per year", money, "fred", "Principal and interest on the typical home with 20% down, 30-year fixed."],
      ["avg_property_tax_bill", "Property tax, per year", money, "property_tax_municipal", "Average total tax on a residential property, before credits."],
      ["annual_ownership_cost", "Ownership cost, per year", money, "derived", "Mortgage plus property tax."],
      ["county_median_hh_income", "County median income", money, "acs_county", "Median household income of the county."],
      ["ownership_burden", "Cost ÷ county income", pct, "derived", "The measure behind the ownership score."],
      ["ownership_burden_town_income", "Cost ÷ town income", pct, "derived", "For comparison only; not used in the score."]
    ]},
    { title: "Renting", rows: [
      ["median_gross_rent", "Median rent, per month", rentMoney, "acs_municipal", "Median gross rent (rent plus utilities)."],
      ["rent_burden", "Yearly rent ÷ county income", pct, "derived", "The measure behind the rental score."],
      ["renters_cost_burdened_share", "Renters paying 30%+", pct, "acs_municipal", "Context only, not scored. Unreliable in small towns."],
      ["fmr_2br", "HUD Fair Market Rent, 2 BR", rentMoney, "hud_county", "Area-wide Fair Market Rent for a two-bedroom home."]
    ]},
    { title: "Moderate-income household", rows: [
      ["ami80_income_limit", "HUD 80% income limit", money, "hud_county", "HUD low-income limit for a four-person household."],
      ["ownership_affordable_at_ami80", "Could afford to own", yesno, "derived", "Yes if ownership cost is 30% or less of the income limit."],
      ["rent_affordable_at_ami80", "Could afford the rent", yesno, "derived", "Yes if a year of median rent is 30% or less of the income limit."]
    ]},
    { title: "Barriers · not scored", rows: [
      ["zri", "Zoning restrictiveness", function (v) { return num(v, 2); }, "nzlud_municipal", "NZLUD index; higher is more restrictive."],
      ["present_need", "Present need", function (v) { return num(v); }, "fourth_round_municipal", "State calculation, October 2024."],
      ["prospective_need_capped", "Prospective need", function (v) { return num(v); }, "fourth_round_municipal", "After the state's cap; October 2024 calculation."],
      ["prospective_need_per_1000_hh", "Per 1,000 households", function (v) { return num(v, 1); }, "derived", "Prospective need ÷ households × 1,000."],
      ["qualified_urban_aid", "Qualified Urban Aid", yesno, "fourth_round_municipal", "No prospective obligation by law; present need may still apply."]
    ]}
  ];
  // summaries.web.json source keys -> manifest source names
  var SUM_TO_MANIFEST = { acs: "acs_municipal", home_value: "acs_municipal", property_tax: "property_tax_municipal",
    hud: "hud_county", fred: "fred_mortgage30", nzlud: "nzlud_municipal", fourth_round: "fourth_round_municipal" };
  var SOURCE_LABELS = { acs_municipal: "U.S. Census Bureau, American Community Survey", acs_county: "U.S. Census Bureau, American Community Survey (county)",
    property_tax_municipal: "NJ Dept. of Community Affairs, Property Tax Tables", hud_county: "HUD Income Limits & Fair Market Rents",
    fred_mortgage30: "Freddie Mac PMMS 30-year rate (via FRED)", nzlud_municipal: "National Zoning and Land Use Database",
    fourth_round_municipal: "NJ Dept. of Community Affairs, Fourth Round obligations", zillow_municipal: "Zillow Home Value Index",
    acs_home_value_history: "U.S. Census Bureau, ACS 5-year (B25077)" };

  // ------------------------------------------------------------------ state
  var D = { rows: [], byId: {}, cols: [], manifest: null, summaries: null, history: null, sources: {} };
  var S = { layer: "ownership_score", bestFirst: true, query: "", favOnly: false, selected: null,
            view: "map", compare: [], sortCol: "ownership_rank", sortAsc: true, tquery: "" };
  var map = null, mapReady = false, bounds = null, hoverId = null, styleOk = false;
  var classCache = {};

  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function load(key, dflt) { try { var v = JSON.parse(localStorage.getItem(key)); return v === null ? dflt : v; } catch (e) { return dflt; } }
  var favorites = load("oh_v2_favorites", []);
  if (!Array.isArray(favorites)) favorites = [];
  S.compare = load("oh_v2_compare", []);
  if (!Array.isArray(S.compare)) S.compare = [];

  var $ = function (id) { return document.getElementById(id); };
  function setStatus(msg, err) { var s = $("status"); s.textContent = msg || ""; s.classList.toggle("err", !!err); }
  function isDark() { return document.documentElement.dataset.theme === "dark"; }
  function nodata() { return getComputedStyle(document.documentElement).getPropertyValue("--nodata").trim(); }
  function palette(layer) { var m = isDark() ? "dark" : "light"; return layer.scheme === "div" ? DIV[m] : VIOLET[m]; }

  // ------------------------------------------------------------------ classes (equal-count groups)
  // 6 groups for the diverging scheme (split at the median), 7 for violet.
  function nClasses(layer) { return layer.scheme === "div" ? 6 : 7; }
  function classesFor(layer) {
    if (classCache[layer.key]) return classCache[layer.key];
    var vals = D.rows.map(function (r) { return r[layer.key]; }).filter(has).map(Number).sort(function (a, b) { return a - b; });
    var breaks = [], k = nClasses(layer);
    for (var i = 1; i < k; i++) breaks.push(vals[Math.min(vals.length - 1, Math.floor(i * vals.length / k))]);
    var mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    return (classCache[layer.key] = { breaks: breaks, min: vals[0], max: vals[vals.length - 1], median: mid, n: vals.length });
  }
  function classIndex(layer, v) {
    var c = classesFor(layer), i = 0;
    while (i < c.breaks.length && Number(v) >= c.breaks[i]) i++;
    return layer.invert ? nClasses(layer) - 1 - i : i;   // index 0 = least affordable (red) for "div"
  }
  function colorFor(layer, v) {
    if (!has(v)) return null;
    var p = palette(layer);
    if (layer.categorical) return isTrue(v) ? p[5] : p[1];
    return p[classIndex(layer, v)];
  }
  function scoreColor(key, v) { return colorFor(LAYER_BY_KEY[key], v) || nodata(); }

  // ------------------------------------------------------------------ tooltips (hover / focus)
  var tipEl = null;
  function tipHTML(el) {
    if (el.dataset.tip) return esc(el.dataset.tip);
    if (el.dataset.stat) {
      var f = el.dataset.stat, srcs = (el.dataset.src || "").split(",").filter(Boolean);
      var label = (D.summaries && D.summaries.blanks && D.summaries.blanks[f]) || "";
      return (label ? "<b>" + esc(label) + "</b>" : "") + srcs.map(function (k) {
        if (k === "derived") return "<span class='tip-src'>Calculated by OpenHousing from:</span>";
        var m = D.sources[SUM_TO_MANIFEST[k]], name = SOURCE_LABELS[SUM_TO_MANIFEST[k]] || k;
        return "<span class='tip-src'>" + esc(name) + (m ? "<em>Data: " + esc(m.vintage) + " · Retrieved " + esc(fmtDate(m.fetched_at || m.fetched)) + "</em>" : "") + "</span>";
      }).join("");
    }
    return "";
  }
  function showTip(el) {
    var html = tipHTML(el); if (!html) return;
    tipEl.innerHTML = html;
    tipEl.hidden = false;
    var r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = Math.min(window.innerWidth - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
    var y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
    el.setAttribute("aria-describedby", "tipbox");
  }
  function hideTip(el) { tipEl.hidden = true; if (el) el.removeAttribute("aria-describedby"); }
  function wireTips() {
    tipEl = document.createElement("div");
    tipEl.id = "tipbox"; tipEl.className = "tipbox"; tipEl.setAttribute("role", "tooltip"); tipEl.hidden = true;
    document.body.appendChild(tipEl);
    var sel = "[data-tip],[data-stat]";
    document.addEventListener("mouseover", function (e) { var t = e.target.closest(sel); if (t) showTip(t); });
    document.addEventListener("mouseout", function (e) { var t = e.target.closest(sel); if (t && !t.contains(e.relatedTarget)) hideTip(t); });
    document.addEventListener("focusin", function (e) { var t = e.target.closest(sel); if (t) showTip(t); });
    document.addEventListener("focusout", function (e) { var t = e.target.closest(sel); if (t) hideTip(t); });
    document.addEventListener("scroll", function () { hideTip(); }, true);
  }
  var INFO_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.2v3.9"/><circle cx="8" cy="5" r=".55" class="i-dot"/></svg>';
  function info(text, label) {
    return '<button type="button" class="info" data-tip="' + esc(text) + '" aria-label="' + esc(label || "More information") + '">' + INFO_SVG + "</button>";
  }

  // ------------------------------------------------------------------ loading
  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }

  function init() {
    wireTips();
    wireUI();
    wireSheet();
    Promise.all([getJSON(PATHS.data), getJSON(PATHS.manifest)]).then(function (res) {
      var split = res[0];
      D.cols = split.columns;
      D.rows = split.data.map(function (a) { var o = {}; for (var i = 0; i < D.cols.length; i++) o[D.cols[i]] = a[i]; return o; });
      D.rows.forEach(function (r) { r.geoid = String(r.geoid); D.byId[r.geoid] = r; });
      D.manifest = res[1];
      (D.manifest.sources || []).forEach(function (s) { D.sources[s.name] = s; });
      setStatus("");
      renderMeta();
      renderSnapshot();
      fillLayerSelect();
      readHash();
      renderAll();
      initMap();
    }).catch(function (e) {
      setStatus("Couldn't load the data (" + e.message + "). If you opened this file directly, serve the repository folder over HTTP.", true);
    });
  }

  function renderMeta() {
    var m = D.manifest;
    var line = "Updated " + fmtDate(m.published_at) + " · " + D.rows.length + " municipalities";
    $("updated").textContent = line;
    $("updated-pop").textContent = "Data updated " + fmtDate(m.published_at) + "." + (m.zillow_included ? "" : " Home values currently come from the Census Bureau.");
    $("source-list").innerHTML = m.sources.filter(function (s) { return s.name !== "acs_county"; }).map(function (s) {
      return "<li><b>" + esc(SOURCE_LABELS[s.name] || s.name) + "</b><span>" + esc(s.vintage) + "</span></li>";
    }).join("");
    $("notices").textContent = m.sources.map(function (s) { return s.attribution || ""; })
      .filter(function (a) { return /not endorsed/.test(a); })
      .map(function (a) { var i = a.indexOf("This product uses"); return i >= 0 ? a.slice(i) : a; }).join(" ");
  }

  function median(a) { a = a.filter(has).map(Number).sort(function (x, y) { return x - y; }); var n = a.length;
    return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; }
  function renderSnapshot() {
    var R = D.rows, col = function (k) { return R.map(function (r) { return r[k]; }); };
    var sum = function (k) { return R.reduce(function (s, r) { return s + (has(r[k]) ? Number(r[k]) : 0); }, 0); };
    var ownOk = R.filter(function (r) { return isTrue(r.ownership_affordable_at_ami80); }).length;
    var ownN = R.filter(function (r) { return has(r.ownership_affordable_at_ami80); }).length;
    var a = D.manifest.assumptions || {};
    var cells = [
      [money(median(col("home_value"))), "Median home value (typical town)"],
      [rentMoney(median(col("median_gross_rent"))), "Median monthly rent (typical town)"],
      [pct(median(col("ownership_burden"))), "Owning ÷ county income (typical town)"],
      [num(a.mortgage_rate_pct, 2) + "%", "30-year mortgage rate used"],
      [ownOk + " of " + ownN, "Towns a moderate-income family could afford to own in"],
      [num(sum("prospective_need_capped")), "Fourth Round prospective need (units)"]
    ];
    $("snapgrid").innerHTML = cells.map(function (c) { return "<div><b>" + esc(c[0]) + "</b><span>" + esc(c[1]) + "</span></div>"; }).join("");
    $("snap-note").textContent = "Medians across towns (each town counts once). Census ACS 2020–2024, NJ DCA, HUD, Freddie Mac. " +
      "Moderate-income: HUD 80% income limit, 4 people, costs at most 30% of income.";
  }

  // Layer picker: a button that opens grouped radio options, each with a plain-language
  // name, a one-line explanation and a color preview for its group.
  var GROUP_NOTES = {
    "Affordability score": "The two scores. Blue is more affordable than the typical NJ town, red less.",
    "Cost compared with income": "The numbers behind the scores. Red means costs take a bigger share of income.",
    "Barriers · shown, not scored": "Possible causes of unaffordability. They never change a score."
  };
  function fillLayerSelect() {
    var pop = $("layer-pop"), groups = [], html = "";
    LAYERS.forEach(function (l) { if (groups.indexOf(l.group) < 0) groups.push(l.group); });
    groups.forEach(function (g) {
      var first = LAYERS.filter(function (l) { return l.group === g; })[0];
      var sw = palette(first).map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("");
      html += '<fieldset class="pk-group"><legend><span class="pk-ramp" aria-hidden="true">' + sw + "</span>" + esc(g) + "</legend>" +
        '<p class="pk-note">' + esc(GROUP_NOTES[g] || "") + "</p>";
      LAYERS.filter(function (l) { return l.group === g; }).forEach(function (l) {
        html += '<label class="pk-opt"><input type="radio" name="layer" value="' + l.key + '"' + (l.key === S.layer ? " checked" : "") + ">" +
          '<span><b>' + esc(l.label) + "</b><small>" + esc(l.sub || "") + "</small></span></label>";
      });
      html += "</fieldset>";
    });
    pop.innerHTML = html;
    updateLayerButton();
  }
  function updateLayerButton() {
    var L = LAYER_BY_KEY[S.layer];
    $("layer-btn-t").textContent = L.label;
    $("layer-btn-s").textContent = L.sub || "";
    document.querySelectorAll('#layer-pop input[name="layer"]').forEach(function (i) { i.checked = i.value === S.layer; });
  }
  function setLayer(key) {
    if (!LAYER_BY_KEY[key] || key === S.layer) return;
    S.layer = key; S.bestFirst = true;
    updateLayerButton(); renderList(); renderLegend(); repaint(); writeHash();
  }
  function openPicker(open) {
    var pop = $("layer-pop"), btn = $("layer-btn");
    pop.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) { var cur = pop.querySelector("input:checked"); if (cur) cur.focus(); }
  }

  // ------------------------------------------------------------------ list (map view)
  function sortedForLayer() {
    var L = LAYER_BY_KEY[S.layer], q = S.query.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (S.favOnly && favorites.indexOf(r.geoid) < 0) return false;
      return !q || (r.name + " " + r.county).toLowerCase().indexOf(q) >= 0;
    });
    var dir = (L.better === "low") ? 1 : -1;
    if (!S.bestFirst) dir = -dir;
    rows.sort(function (a, b) {
      var va = a[L.key], vb = b[L.key];
      if (L.categorical) { va = isTrue(va) ? 1 : has(va) ? 0 : null; vb = isTrue(vb) ? 1 : has(vb) ? 0 : null; }
      if (!has(va) && !has(vb)) return a.name.localeCompare(b.name);
      if (!has(va)) return 1;
      if (!has(vb)) return -1;
      return dir * (va - vb) || a.name.localeCompare(b.name);
    });
    return rows;
  }

  function renderList() {
    var L = LAYER_BY_KEY[S.layer];
    $("layer-info").dataset.tip = L.desc;
    $("sort-best").textContent = L.best;
    $("sort-worst").textContent = L.worst;
    $("sort-best").setAttribute("aria-pressed", String(S.bestFirst));
    $("sort-worst").setAttribute("aria-pressed", String(!S.bestFirst));
    var rows = sortedForLayer();
    $("listcount").textContent = rows.length + " of " + D.rows.length;
    var ol = $("list"), frag = document.createDocumentFragment();
    ol.innerHTML = "";
    if (mobile.matches && S.query && SHEET.state === "peek") setSheet("half");
    rows.forEach(function (r, i) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.dataset.geoid = r.geoid;
      if (S.selected === r.geoid) b.setAttribute("aria-current", "true");
      var rankTxt = L.rank && has(r[L.rank]) ? r[L.rank] : (i + 1);
      var c = colorFor(L, r[L.key]) || nodata();
      var star = favorites.indexOf(r.geoid) >= 0 ? ' <span class="star" aria-label="favorite">★</span>' : "";
      b.innerHTML = '<span class="n">' + rankTxt + '</span><i class="dot" style="background:' + c + '" aria-hidden="true"></i>' +
        '<span class="nm">' + esc(r.name) + star + '<span class="ct">' + esc(r.county) + ' County</span></span>' +
        '<span class="v' + (has(r[L.key]) ? "" : " na") + '">' + esc(has(r[L.key]) ? L.fmt(r[L.key]) : "–") + "</span>";
      b.setAttribute("aria-label", r.name + ", " + r.county + " County: " + L.label + " " + L.fmt(r[L.key]));
      li.appendChild(b);
      frag.appendChild(li);
    });
    ol.appendChild(frag);
  }

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    var L = LAYER_BY_KEY[S.layer], el = $("legend"), p = palette(L);
    var help = L.desc + (L.categorical ? "" : L.scheme === "div"
      ? " Colors split towns into six equal-size groups: reds are below the New Jersey median, blues above it. Gray means not enough data."
      : " Colors split towns into seven equal-size groups. Gray means not enough data.");
    var html = "<h3>" + esc(L.label) + " " + info(help, "About this layer") + "</h3>";
    if (L.categorical) {
      html += '<div class="cats"><div><i style="background:' + p[5] + '"></i>Yes</div><div><i style="background:' + p[1] + '"></i>No</div></div>';
    } else {
      // p[0] is the least affordable / lowest class, drawn left to right.
      html += '<div class="ramp" aria-hidden="true">' + p.map(function (col) { return '<span style="background:' + col + '"></span>'; }).join("") + "</div>";
      html += '<div class="ends"><span>' + esc(L.scheme === "div" ? "Less" : L.ends[0]) + "</span><span>" +
              esc(L.scheme === "div" ? "More affordable" : L.ends[1]) + "</span></div>";
    }
    var missing = D.rows.filter(function (x) { return !has(x[L.key]); }).length;
    if (missing) html += '<div class="nd"><i aria-hidden="true"></i>Not enough data (' + missing + ")</div>";
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ map
  function initMap() {
    if (!window.mapboxgl) { mapFailed("The map library didn't load."); return; }
    mapboxgl.accessToken = MAPBOX_TOKEN;
    try {
      map = new mapboxgl.Map({ container: "map", style: styleUrl(), bounds: NJ_BOUNDS, fitBoundsOptions: { padding: 24 }, attributionControl: true });
    } catch (e) { mapFailed(e.message); return; }
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("error", function (e) {
      var msg = e && e.error && e.error.message || "";
      if (/401|403|token|Unauthorized|Forbidden/i.test(msg)) mapFailed("Map tiles were refused (" + msg + ").");
    });
    // Track style readiness ourselves: map.isStyleLoaded() stays false while base
    // tiles are still loading, which could skip adding our layers.
    map.on("style.load", function () { styleOk = true; addLayers(); });
    loadBounds();
    wireMapEvents();
  }
  function styleUrl() { return isDark() ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11"; }
  function mapStatus(msg) { var el = $("map-status"); if (!msg) { el.classList.add("done"); return; } el.classList.remove("done"); $("map-status-txt").textContent = msg; }
  function mapFailed(msg) { mapStatus(""); $("map-error").hidden = false; $("map-error-txt").textContent = msg + " Everything else works: use the list or the Table view."; }
  function loadBounds() {
    $("map-error").hidden = true;
    mapStatus("Loading town boundaries…");
    var slow = setTimeout(function () { mapStatus("Still loading town boundaries…"); }, 5000);
    return getJSON(PATHS.bounds).then(function (gj) { clearTimeout(slow); bounds = gj; if (styleOk) addLayers(); })
      .catch(function (e) { clearTimeout(slow); mapFailed("Town boundaries didn't load (" + e.message + ")."); });
  }
  function resetView() { if (!$("drawer").hidden) closeProfile(); if (map) map.fitBounds(NJ_BOUNDS, { padding: 24, duration: 700 }); }
  function showHint() {
    var seen = false;
    try { seen = localStorage.getItem("oh_v2_hint") === "1"; } catch (e) {}
    if (seen || window.matchMedia("(hover: none)").matches) return;
    $("hint").hidden = false;
    setTimeout(hideHint, 7000);
  }
  function hideHint() {
    var h = $("hint"); if (h.hidden) return;
    h.classList.add("out"); setTimeout(function () { h.hidden = true; }, 400);
    try { localStorage.setItem("oh_v2_hint", "1"); } catch (e) {}
  }

  function paintedData() {
    var L = LAYER_BY_KEY[S.layer];
    bounds.features.forEach(function (f) {
      var r = D.byId[f.properties.geoid];
      f.properties.color = r ? colorFor(L, r[L.key]) : null;
      f.properties.label = r ? r.name.replace(/ (Township|Borough|City|Town|Village)$/, "") : "";
    });
    return bounds;
  }

  function addLayers() {
    if (!bounds) return;
    if (map.getSource("munis")) { mapReady = true; repaint(); return; }
    var firstLabel = (map.getStyle().layers.find(function (l) { return l.type === "symbol"; }) || {}).id;
    map.addSource("munis", { type: "geojson", data: paintedData(), promoteId: "geoid" });
    map.addLayer({ id: "muni-fill", type: "fill", source: "munis",
      paint: { "fill-color": ["coalesce", ["get", "color"], nodata()],
               // lighter as you zoom in, so streets and labels stay readable
               "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.78, 9, 0.62, 11, 0.42, 13, 0.28, 15, 0.2] } }, firstLabel);
    map.addLayer({ id: "muni-line", type: "line", source: "munis",
      paint: { "line-color": isDark() ? "#0a0d13" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.35, 11, 1.2] } }, firstLabel);
    map.addLayer({ id: "muni-hover", type: "line", source: "munis",
      paint: { "line-color": isDark() ? "#ffffff" : "#0b0f19", "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 1.6, 0] } });
    map.addLayer({ id: "muni-sel", type: "line", source: "munis", filter: ["==", ["get", "geoid"], S.selected || ""],
      paint: { "line-color": isDark() ? "#ffffff" : "#0b0f19", "line-width": 2.6 } });
    // Town names on top of the colors: dark text with a light halo (inverted in
    // dark mode) so they read over any fill. Appear from zoom 8.5 and grow.
    map.addSource("muni-pts", { type: "geojson", data: labelPoints() });
    map.addLayer({ id: "muni-labels", type: "symbol", source: "muni-pts", minzoom: 8.5,
      layout: { "text-field": ["get", "label"], "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
                "text-size": ["interpolate", ["linear"], ["zoom"], 8.5, 10.5, 11, 13, 14, 15],
                "text-max-width": 7, "text-padding": 4, "symbol-placement": "point" },
      paint: { "text-color": isDark() ? "#f2f4f8" : "#141a26", "text-halo-color": isDark() ? "rgba(10,13,19,.9)" : "rgba(255,255,255,.95)",
               "text-halo-width": 1.6, "text-halo-blur": 0.3 } });
    // From zoom 8.5 our labels name every NJ municipality, so the base map's own NJ
    // town labels would duplicate them: hide those (only in NJ, only from 8.5).
    // Labels outside NJ and at statewide zoom are untouched.
    ["settlement-minor-label", "settlement-major-label"].forEach(function (id) {
      var l = map.getLayer(id); if (!l) return;
      var f = map.getFilter(id);
      var notNJ = ["step", ["zoom"], true, 8.5, ["!=", ["get", "iso_3166_2"], "US-NJ"]];
      try { map.setFilter(id, f ? ["all", f, notNJ] : notNJ); } catch (e) { /* keep the base style if the filter is rejected */ }
    });
    clarifyBaseLabels();
    mapReady = true;
    mapStatus("");
    showHint();
  }

  // One label point per town (labels on the polygon source repeat once per map
  // tile). Point = area-weighted centroid of the town's largest polygon.
  var labelCache = null;
  function labelPoints() {
    if (labelCache) return labelCache;
    var feats = bounds.features.map(function (f) {
      var polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates, best = null, bestA = -1;
      polys.forEach(function (p) {
        var ring = p[0], a = 0, cx = 0, cy = 0;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          var cr = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
          a += cr; cx += (ring[j][0] + ring[i][0]) * cr; cy += (ring[j][1] + ring[i][1]) * cr;
        }
        if (Math.abs(a) > bestA && a !== 0) { bestA = Math.abs(a); best = [cx / (3 * a), cy / (3 * a)]; }
      });
      return { type: "Feature", geometry: { type: "Point", coordinates: best || polys[0][0][0] },
               properties: { label: f.properties.label || "" } };
    });
    return (labelCache = { type: "FeatureCollection", features: feats });
  }

  // Make the base map's own labels (streets, places, water) easier to read over
  // the colored fills: darker text and a solid halo.
  function clarifyBaseLabels() {
    var dark = isDark();
    map.getStyle().layers.forEach(function (l) {
      if (l.type !== "symbol" || l.id === "muni-labels" || !l.layout || !l.layout["text-field"]) return;
      try {
        map.setPaintProperty(l.id, "text-halo-color", dark ? "rgba(10,13,19,.85)" : "rgba(255,255,255,.92)");
        map.setPaintProperty(l.id, "text-halo-width", 1.4);
        if (/road|street|place|settlement|poi|label/.test(l.id)) map.setPaintProperty(l.id, "text-color", dark ? "#dfe4ee" : "#2b3140");
      } catch (e) { /* some layers don't take these properties; leave them as styled */ }
    });
  }

  function repaint() {
    if (!mapReady || !map.getSource("munis")) return;
    map.getSource("munis").setData(paintedData());
    map.setPaintProperty("muni-fill", "fill-color", ["coalesce", ["get", "color"], nodata()]);
    map.setFilter("muni-sel", ["==", ["get", "geoid"], S.selected || ""]);
  }

  function wireMapEvents() {
    var tip = $("tip");
    map.on("mousemove", "muni-fill", function (e) {
      var f = e.features && e.features[0]; if (!f) return;
      map.getCanvas().style.cursor = "pointer";
      if (hoverId !== null && hoverId !== f.id) map.setFeatureState({ source: "munis", id: hoverId }, { hover: false });
      hoverId = f.id;
      map.setFeatureState({ source: "munis", id: hoverId }, { hover: true });
      var r = D.byId[f.properties.geoid], L = LAYER_BY_KEY[S.layer];
      if (!r) return;
      tip.innerHTML = "<b>" + esc(r.name) + "</b><span>" + esc(r.county) + " County</span><span class='tv'>" +
        '<i class="dot" style="background:' + (colorFor(L, r[L.key]) || nodata()) + '"></i>' + esc(L.label) + ": <b>" + esc(L.fmt(r[L.key])) + "</b></span>";
      tip.style.display = "block";
      var x = e.point.x + 14, y = e.point.y + 14, w = tip.offsetWidth, h = tip.offsetHeight, W = map.getCanvas().clientWidth;
      if (x + w > W - 8) x = e.point.x - w - 14;
      if (y + h > map.getCanvas().clientHeight - 8) y = e.point.y - h - 14;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
    map.on("mouseleave", "muni-fill", function () {
      map.getCanvas().style.cursor = "";
      if (hoverId !== null) map.setFeatureState({ source: "munis", id: hoverId }, { hover: false });
      hoverId = null; tip.style.display = "none";
    });
    map.on("click", "muni-fill", function (e) { var f = e.features && e.features[0]; hideHint(); if (f) openProfile(f.properties.geoid, false); });
  }

  function zoomTo(geoid) {
    if (!mapReady || !bounds) return;
    var f = bounds.features.find(function (x) { return x.properties.geoid === geoid; }); if (!f) return;
    var b = new mapboxgl.LngLatBounds();
    (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(function (poly) { poly[0].forEach(function (c) { b.extend(c); }); });
    var wide = window.innerWidth > 860;
    map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: wide ? 500 : 60 }, maxZoom: 12.5, duration: 600 });
  }

  // ------------------------------------------------------------------ profile
  function srcTip(key, r, help) {
    var parts = [help];
    if (key === "derived") parts.push("Calculated by OpenHousing.");
    else if (key === "home_value") parts.push("Source: " + (r.home_value_source || "") + " (" + (r.home_value_vintage || "") + ").");
    else if (key === "fred") { var f = D.sources.fred_mortgage30; if (f) parts.push("Rate " + num(r.mortgage_rate_pct, 2) + "%: " + f.vintage + "."); }
    else { var s = D.sources[key]; if (s) parts.push("Source: " + (SOURCE_LABELS[key] || key) + ", " + s.vintage + "."); }
    return parts.join(" ");
  }
  // "no usable measure in any source; ownership burden unavailable" ->
  // "No usable measure in any source. Ownership burden unavailable."
  function sentences(text) {
    return String(text || "").split(/;\s*/).filter(Boolean).map(function (p) {
      p = p.trim(); return p.charAt(0).toUpperCase() + p.slice(1) + (/[.!?]$/.test(p) ? "" : ".");
    }).join(" ");
  }
  function badge(level, reasons) {
    if (!has(level)) return "";
    var cls = level === "insufficient data" ? "none" : level;
    var txt = level === "insufficient data" ? "Insufficient data" : level.charAt(0).toUpperCase() + level.slice(1) + " confidence";
    var tip = reasons ? ' data-tip="' + esc(sentences(reasons)) + '" tabindex="0"' : "";
    return '<span class="badge ' + cls + '"' + tip + ">" + esc(txt) + "</span>";
  }
  function scoreBlock(title, key, rankKey, confKey, reasonKey, r, n) {
    var v = r[key], col = scoreColor(key, v);
    return '<div class="sb"><div class="sb-k">' + esc(title) + '</div><div class="sb-main"><i class="circle" style="background:' + col + '" aria-hidden="true"></i>' +
      '<div><div class="sb-v">' + (has(v) ? num(v, 1) : "–") + "<small>/ 100</small></div>" +
      '<div class="sb-r">' + (has(r[rankKey]) ? "Rank " + r[rankKey] + " of " + n : "Not scored") + "</div></div></div>" +
      badge(r[confKey], r[reasonKey]) + "</div>";
  }

  function openProfile(geoid, zoom) {
    var r = D.byId[geoid]; if (!r) return;
    S.selected = geoid;
    $("drawer").hidden = false;
    document.body.classList.add("profile-open");
    if (mobile.matches) setSheet("peek");
    $("p-name").innerHTML = esc(r.name) + ' <span class="type">' + esc(r.mun_type) + "</span>";
    $("p-sub").textContent = r.county + " County · Code " + r.mun_code + " · Pop. " + num(r.population);
    updateProfileButtons();
    var nOwn = D.rows.filter(function (x) { return has(x.ownership_score); }).length;
    var nRent = D.rows.filter(function (x) { return has(x.rental_score); }).length;
    var a = (D.manifest && D.manifest.assumptions) || {};
    var html = '<div class="scores">' +
      scoreBlock("Owning", "ownership_score", "ownership_rank", "ownership_confidence", "ownership_confidence_reasons", r, nOwn) +
      scoreBlock("Renting", "rental_score", "rental_rank", "rental_confidence", "rental_confidence_reasons", r, nRent) + "</div>" +
      '<p class="higher">Higher is more affordable ' + info("Scores are percentiles across New Jersey towns (100 = smallest share of county income). Assumes " +
        a.down_payment_pct + "% down, " + a.loan_term_years + "-year fixed at " + num(a.mortgage_rate_pct, 2) + "%. Excludes " + (a.excluded_costs || []).join(", ") + ".", "How scores work") + "</p>";
    html += '<section class="chart-sec"><h3>Home value <span id="hv-range"></span> ' + info("Census ACS 5-year median value of owner-occupied homes (owners' own estimates). Each point is a five-year period ending in that year (2009 = 2005–2009) and overlaps the next, in dollars of that period's final year, not adjusted to today. The shaded band is the survey's margin of error (90% confidence): the range the true value very likely falls in.", "About this graph") +
      '</h3><div id="hv-chart" class="hv"></div></section>';
    html += '<h3>In plain English</h3><div class="summary" id="p-summary">' + (D.summaries ? "" : "Loading summary…") + "</div>";
    SECTIONS.forEach(function (sec) {
      html += "<h3>" + esc(sec.title) + '</h3><dl class="kv">';
      sec.rows.forEach(function (row) {
        var v = r[row[0]], txt = row[2](v);
        html += '<div><dt data-tip="' + esc(srcTip(row[3], r, row[4])) + '" tabindex="0">' + esc(row[1]) + "</dt><dd" + (txt === UNAV ? ' class="na"' : "") + ">" + esc(txt) + "</dd></div>";
      });
      html += "</dl>";
    });
    $("d-body").innerHTML = html;
    $("d-body").scrollTop = 0;
    fillSummary(r);
    fillHistory(r);
    $("p-name").focus();
    if (zoom !== false) zoomTo(geoid);
    repaint(); markListSelection(); writeHash();
  }

  // Summary sentence template id -> section heading
  var SUMMARY_GROUP = {
    home_value: "Owning", home_value_topcoded: "Owning", home_value_missing: "Owning", ownership_cost: "Owning",
    ownership_rank: "Owning", ownership_most: "Owning", ownership_least: "Owning",
    rent: "Renting", rent_most: "Renting", rent_least: "Renting", rent_missing: "Renting",
    renters_burdened: "Renting", renters_burdened_unreliable: "Renting",
    ami80: "A moderate-income family", ami80_own_only: "A moderate-income family",
    obligation: "Obligations & zoning", obligation_urban_aid: "Obligations & zoning", zoning_restrictive: "Obligations & zoning",
    limited_data: "Notes", acs_value_note: "Notes"
  };
  var SUMMARY_ORDER = ["Owning", "Renting", "A moderate-income family", "Obligations & zoning", "Notes"];
  function fillSummary(r) {
    var go = function () {
      var t = D.summaries.towns[r.geoid], el = $("p-summary");
      if (!el || S.selected !== r.geoid) return;
      if (!t) { el.textContent = "No summary available."; return; }
      // Sentences are grouped into short labelled sections. Each statistic is
      // underlined and colored; hover or focus shows its source and data period.
      var groups = [], byName = {};
      t.sentences.forEach(function (s) {
        var g = SUMMARY_GROUP[s[3]] || "Notes";
        if (!byName[g]) { byName[g] = []; groups.push(g); }
        byName[g].push((s[2] || [s[0]]).map(function (seg) {
          if (typeof seg === "string") return esc(seg);
          return '<span class="stat" tabindex="0" data-stat="' + esc(seg.f) + '" data-src="' + esc(seg.s.join(",")) + '">' + esc(seg.t) + "</span>";
        }).join(""));
      });
      groups.sort(function (a, b) { return SUMMARY_ORDER.indexOf(a) - SUMMARY_ORDER.indexOf(b); });
      el.innerHTML = groups.map(function (g) {
        return '<div class="sum-sec"><h4>' + esc(g) + "</h4><p>" + byName[g].join(" ") + "</p></div>";
      }).join("");
    };
    if (D.summaries) return go();
    getJSON(PATHS.summaries).then(function (s) { D.summaries = s; go(); })
      .catch(function () { var el = $("p-summary"); if (el) el.textContent = "The summary couldn't be loaded."; });
  }

  // Smooth curve through points (monotone cubic: no overshoot, so it never
  // invents a peak or dip that isn't in the data).
  function smoothPath(P, move) {
    var n = P.length; if (n < 2) return "";
    var dx = [], dy = [], m = [], t = [];
    for (var i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; dy[i] = P[i + 1][1] - P[i][1]; m[i] = dy[i] / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      var a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { var k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    var d = (move === false ? "L" : "M") + P[0][0].toFixed(1) + " " + P[0][1].toFixed(1);
    for (i = 0; i < n - 1; i++) {
      var c = dx[i] / 3;
      d += "C" + (P[i][0] + c).toFixed(1) + " " + (P[i][1] + c * t[i]).toFixed(1) + " " + (P[i + 1][0] - c).toFixed(1) + " " +
           (P[i + 1][1] - c * t[i + 1]).toFixed(1) + " " + P[i + 1][0].toFixed(1) + " " + P[i + 1][1].toFixed(1);
    }
    return d;
  }

  // Home value graph: smooth line, endpoints labelled, crosshair + readout on hover/keyboard.
  function fillHistory(r) {
    var go = function () {
      var el = $("hv-chart"); if (!el || S.selected !== r.geoid) return;
      var H = D.history, pts = (H.towns[r.geoid] || []).map(function (p, i) { return p && has(p[0]) ? { y: H.years[i], v: p[0], m: p[1], top: p[2] } : null; }).filter(Boolean);
      if (pts.length < 2) { el.innerHTML = '<p class="na">Unavailable</p>'; $("hv-range").textContent = ""; return; }
      $("hv-range").textContent = pts[0].y + "–" + pts[pts.length - 1].y;   // matches the axis (each point = 5-year period ending that year)
      // Draw at the container's real pixel width so text stays a fixed size.
      var W = Math.max(240, Math.round(el.clientWidth || 380)), Ht = 124, pl = 4, pr = 6, pt = 22, pb = 20;
      var lo = Math.min.apply(null, pts.map(function (p) { return p.v - (p.m || 0); }));
      var hi = Math.max.apply(null, pts.map(function (p) { return p.v + (p.m || 0); }));
      var x0 = pts[0].y, x1 = pts[pts.length - 1].y;
      var X = function (y) { return pl + (y - x0) / (x1 - x0) * (W - pl - pr); };
      var Y = function (v) { return pt + (1 - (v - lo) / ((hi - lo) || 1)) * (Ht - pt - pb); };
      var line = smoothPath(pts.map(function (p) { return [X(p.y), Y(p.v)]; }));
      // Likely range (estimate ± 90% margin of error): dashed edges with a faint
      // tint between them, instead of a solid filled band.
      var upP = pts.map(function (p) { return [X(p.y), Y(p.v + (p.m || 0))]; });
      var loP = pts.map(function (p) { return [X(p.y), Y(Math.max(0, p.v - (p.m || 0)))]; });
      var upper = smoothPath(upP), lower = smoothPath(loP);
      var area = upper + smoothPath(loP.slice().reverse(), false) + "Z";
      var first = pts[0], last = pts[pts.length - 1];
      el.innerHTML = '<svg viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="Median home value from ' + (first.y - 4) + "–" + first.y + " (" + money(first.v) + ") to " +
        (last.y - 4) + "–" + last.y + " (" + money(last.v) + ')">' +
        '<path class="hv-tint" d="' + area + '"/><path class="hv-edge" d="' + upper + '"/><path class="hv-edge" d="' + lower + '"/>' +
        '<rect class="hv-sel" rx="6" width="12" x="0" y="0" height="0" visibility="hidden"/>' +
        '<path class="hv-line" d="' + line + '"/>' +
        '<circle class="hv-end" cx="' + X(last.y) + '" cy="' + Y(last.v) + '" r="3.5"/>' +
        '<text class="hv-lbl" x="' + X(first.y) + '" y="12">' + money(first.v) + '</text>' +
        '<text class="hv-lbl" x="' + X(last.y) + '" y="12" text-anchor="end">' + money(last.v) + "</text>" +
        '<text class="hv-ax" x="' + X(first.y) + '" y="' + (Ht - 4) + '">' + first.y + '</text>' +
        '<text class="hv-ax" x="' + X(last.y) + '" y="' + (Ht - 4) + '" text-anchor="end">' + last.y + "</text>" +
        '<line class="hv-x" y1="' + pt + '" y2="' + (Ht - pb) + '" x1="0" x2="0" visibility="hidden"/><circle class="hv-dot" r="4" cx="0" cy="0" visibility="hidden"/></svg>' +
        '<div class="hv-read" aria-live="polite"></div>' +
        '<div class="hv-key"><span><i class="k-line"></i>Median home value</span><span data-tip="The Census estimates home values from a survey of some households, not every home. ' +
        'The dashed lines mark the range the true value very likely falls in (90% confidence). Hover a year to highlight it. A wider range means a smaller sample and a less certain estimate." tabindex="0">' +
        '<i class="k-band"></i>Likely range (survey margin of error)</span></div>';
      var svg = el.querySelector("svg"), xl = el.querySelector(".hv-x"), dot = el.querySelector(".hv-dot"), read = el.querySelector(".hv-read"), sel = el.querySelector(".hv-sel");
      var showAt = function (i) {
        var p = pts[i]; xl.setAttribute("x1", X(p.y)); xl.setAttribute("x2", X(p.y)); dot.setAttribute("cx", X(p.y)); dot.setAttribute("cy", Y(p.v));
        xl.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
        // highlight that year's likely range as a rounded bar
        var top = Y(p.v + (p.m || 0)), bot = Y(Math.max(0, p.v - (p.m || 0)));
        var hgt = Math.max(12, bot - top), mid = (top + bot) / 2;
        sel.setAttribute("x", X(p.y) - 6); sel.setAttribute("y", mid - hgt / 2); sel.setAttribute("height", hgt); sel.setAttribute("visibility", "visible");
        read.textContent = (p.y - 4) + "–" + p.y + ": " + (p.top ? "at least " : "") + money(p.v) +
          (p.m ? " · likely " + money(Math.max(0, p.v - p.m)) + "–" + money(p.v + p.m) : "");
      };
      var clear = function () { xl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); sel.setAttribute("visibility", "hidden"); read.textContent = ""; };
      svg.addEventListener("mousemove", function (e) {
        var b = svg.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W, best = 0;
        pts.forEach(function (p, i) { if (Math.abs(X(p.y) - x) < Math.abs(X(pts[best].y) - x)) best = i; });
        showAt(best);
      });
      svg.addEventListener("mouseleave", clear);
      svg.setAttribute("tabindex", "0");
      var ki = pts.length - 1;
      svg.addEventListener("keydown", function (e) {
        if (e.key === "ArrowLeft") { ki = Math.max(0, ki - 1); showAt(ki); e.preventDefault(); }
        if (e.key === "ArrowRight") { ki = Math.min(pts.length - 1, ki + 1); showAt(ki); e.preventDefault(); }
      });
      svg.addEventListener("focus", function () { showAt(ki); });
      svg.addEventListener("blur", clear);
    };
    if (D.history) return go();
    getJSON(PATHS.history).then(function (h) { D.history = h; go(); })
      .catch(function () { var el = $("hv-chart"); if (el) el.innerHTML = '<p class="na">Unavailable</p>'; });
  }

  function closeProfile() {
    var prev = S.selected;
    $("drawer").hidden = true;
    document.body.classList.remove("profile-open");
    S.selected = null;
    hideTip();
    repaint(); markListSelection(); writeHash();
    var b = document.querySelector('.list button[data-geoid="' + prev + '"]');
    // Return focus to the town in the list without scrolling the (mobile) sheet out of place.
    if (b && S.view === "map") b.focus({ preventScroll: true });
    $("side").scrollTop = 0;
  }
  function markListSelection() {
    document.querySelectorAll(".list button").forEach(function (b) {
      if (b.dataset.geoid === S.selected) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
  }
  function updateProfileButtons() {
    var g = S.selected; if (!g) return;
    var fav = favorites.indexOf(g) >= 0, inCmp = S.compare.indexOf(g) >= 0;
    var fb = $("fav-btn"), cb = $("cmp-btn");
    fb.setAttribute("aria-pressed", String(fav)); fb.dataset.tip = fav ? "Remove from favorites" : "Add to favorites";
    fb.setAttribute("aria-label", fb.dataset.tip); fb.querySelector("span").textContent = fav ? "★" : "☆";
    cb.setAttribute("aria-pressed", String(inCmp));
    cb.disabled = !inCmp && S.compare.length >= MAX_COMPARE;
    cb.dataset.tip = inCmp ? "Remove from comparison" : (cb.disabled ? "You can compare up to " + MAX_COMPARE + " towns" : "Add to comparison");
    cb.setAttribute("aria-label", cb.dataset.tip);
  }

  // ------------------------------------------------------------------ favorites & compare
  function toggleFavorite() {
    var g = S.selected, i = favorites.indexOf(g);
    if (i >= 0) favorites.splice(i, 1); else favorites.push(g);
    store("oh_v2_favorites", favorites);
    updateProfileButtons(); renderList();
  }
  function toggleCompare(g) {
    var i = S.compare.indexOf(g);
    if (i >= 0) S.compare.splice(i, 1);
    else if (S.compare.length < MAX_COMPARE) S.compare.push(g);
    store("oh_v2_compare", S.compare);
    updateProfileButtons(); renderCompare();
  }
  function rankCell(key, r) {
    var rank = key === "ownership" ? r.ownership_rank : r.rental_rank, sc = r[key + "_score"];
    return has(rank) ? '<i class="dot" style="background:' + scoreColor(key + "_score", sc) + '" aria-hidden="true"></i>' + esc(ordinal(rank)) : UNAV;
  }
  function renderCompare() {
    $("compare-count").textContent = S.compare.length;
    var wrap = $("compare-wrap"), towns = S.compare.map(function (g) { return D.byId[g]; }).filter(Boolean);
    $("dl-compare").disabled = !towns.length;
    $("compare-hint").textContent = towns.length ? "" : "Open a town and choose Compare to add it here (up to three).";
    if (!towns.length) { wrap.innerHTML = ""; return; }
    var h = '<table class="dt cmp"><caption class="sr">Side-by-side comparison</caption><thead><tr><th scope="col">Measure</th>';
    towns.forEach(function (t) {
      h += '<th scope="col" class="l">' + esc(t.name) + '<br><span class="muted">' + esc(t.county) + ' County</span><br>' +
        '<button type="button" class="linkbtn" data-open="' + t.geoid + '">Profile</button> · <button type="button" class="linkbtn" data-remove="' + t.geoid + '">Remove</button></th>';
    });
    h += "</tr></thead><tbody>";
    var rows = [["ownership_score", "Ownership score", function (v) { return num(v, 1); }], ["__own_rank", "Ownership rank"],
      ["ownership_confidence", "Ownership confidence", function (v) { return has(v) ? v : UNAV; }],
      ["rental_score", "Rental score", function (v) { return num(v, 1); }], ["__rent_rank", "Rental rank"],
      ["rental_confidence", "Rental confidence", function (v) { return has(v) ? v : UNAV; }]];
    SECTIONS.forEach(function (sec) { sec.rows.forEach(function (r) { rows.push([r[0], r[1], r[2]]); }); });
    rows.forEach(function (row) {
      h += '<tr><th scope="row" class="l">' + esc(row[1]) + "</th>";
      towns.forEach(function (t) {
        var cell = row[0] === "__own_rank" ? rankCell("ownership", t) : row[0] === "__rent_rank" ? rankCell("rental", t) : esc(row[2](t[row[0]]));
        h += '<td class="l">' + cell + "</td>";
      });
      h += "</tr>";
    });
    wrap.innerHTML = h + "</tbody></table>";
  }

  // ------------------------------------------------------------------ table view
  var TCOLS = [
    ["name", "Municipality", null, "l"], ["county", "County", null, "l"],
    ["ownership_rank", "Own rank", "rank:ownership"], ["ownership_score", "Own score", function (v) { return num(v, 1); }],
    ["ownership_burden", "Owning ÷ income", function (v) { return pct(v); }],
    ["ownership_confidence", "Own confidence", function (v) { return has(v) ? v : UNAV; }, "l"],
    ["rental_rank", "Rent rank", "rank:rental"], ["rental_score", "Rent score", function (v) { return num(v, 1); }],
    ["rent_burden", "Rent ÷ income", function (v) { return pct(v); }],
    ["rental_confidence", "Rent confidence", function (v) { return has(v) ? v : UNAV; }, "l"],
    ["home_value", "Home value", money], ["median_gross_rent", "Median rent", rentMoney],
    ["renters_cost_burdened_share", "Renters 30%+", function (v) { return pct(v); }],
    ["prospective_need_capped", "Prospective need", function (v) { return num(v); }],
    ["prospective_need_per_1000_hh", "Per 1,000 hh", function (v) { return num(v, 1); }],
    ["qualified_urban_aid", "Urban Aid", yesno, "l"], ["zri", "Zoning", function (v) { return num(v, 2); }]
  ];
  function renderTableHead() {
    document.querySelector("#table thead").innerHTML = "<tr>" + TCOLS.map(function (c) {
      var sort = S.sortCol === c[0] ? (S.sortAsc ? "ascending" : "descending") : "none";
      return '<th scope="col" class="' + (c[3] || "") + '" aria-sort="' + sort + '"><button type="button" data-sort="' + c[0] + '">' + esc(c[1]) + "</button></th>";
    }).join("") + "</tr>";
  }
  function renderTable() {
    renderTableHead();
    var q = S.tquery.trim().toLowerCase(), col = S.sortCol, asc = S.sortAsc ? 1 : -1;
    var rows = D.rows.filter(function (r) { return !q || (r.name + " " + r.county).toLowerCase().indexOf(q) >= 0; });
    rows.sort(function (a, b) {
      var va = a[col], vb = b[col];
      if (!has(va) && !has(vb)) return a.name.localeCompare(b.name);
      if (!has(va)) return 1;
      if (!has(vb)) return -1;
      if (typeof va === "string" || typeof vb === "string") return asc * String(va).localeCompare(String(vb));
      return asc * (va - vb) || a.name.localeCompare(b.name);
    });
    document.querySelector("#table tbody").innerHTML = rows.map(function (r) {
      return "<tr>" + TCOLS.map(function (c, i) {
        var v = r[c[0]];
        if (i === 0) return '<th scope="row" class="l"><button type="button" class="linkbtn" data-open="' + r.geoid + '">' + esc(r.name) + "</button></th>";
        if (typeof c[2] === "string" && c[2].indexOf("rank:") === 0) return '<td class="rk">' + rankCell(c[2].slice(5), r).replace(/(\d+)(st|nd|rd|th)/, "$1") + "</td>";
        var txt = c[2] ? c[2](v) : (has(v) ? v : UNAV);
        return '<td class="' + (c[3] || "") + (txt === UNAV ? " muted" : "") + '">' + esc(txt) + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }

  // ------------------------------------------------------------------ downloads
  function csvFor(rows) {
    var q = function (v) { if (!has(v)) return ""; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [D.cols.join(",")].concat(rows.map(function (r) { return D.cols.map(function (c) { return q(r[c]); }).join(","); })).join("\n") + "\n";
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

  // ------------------------------------------------------------------ views & hash
  function setView(v) {
    S.view = v;
    ["map", "table", "compare"].forEach(function (k) {
      $(k + "-view").hidden = k !== v;
      document.querySelector('.tab[data-view="' + k + '"]').setAttribute("aria-pressed", String(k === v));
    });
    if (v === "table") renderTable();
    if (v === "compare") renderCompare();
    if (v === "map" && map) setTimeout(function () { map.resize(); }, 0);
    writeHash();
  }
  function writeHash() {
    var parts = [];
    if (S.view !== "map") parts.push("view=" + S.view);
    if (S.layer !== "ownership_score") parts.push("layer=" + S.layer);
    if (S.selected) parts.push("town=" + S.selected);
    var h = parts.length ? "#" + parts.join("&") : "";
    if (location.hash !== h) history.replaceState(null, "", h || location.pathname + location.search);
  }
  function readHash() {
    var p = {}; location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var a = kv.split("="); if (a[0]) p[a[0]] = decodeURIComponent(a[1] || ""); });
    if (p.layer && LAYER_BY_KEY[p.layer]) { S.layer = p.layer; updateLayerButton(); }
    if (p.view && ["map", "table", "compare"].indexOf(p.view) >= 0) S.view = p.view;
    if (p.town && D.byId[p.town]) S.selected = p.town;
  }
  function renderAll() {
    renderList(); renderLegend(); renderCompare();
    setView(S.view);
    if (S.selected) openProfile(S.selected, false);
  }

  // ------------------------------------------------------------------ events
  function wirePopover(btnId, popId) {
    var b = $(btnId), p = $(popId);
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      document.querySelectorAll(".popover.open").forEach(function (o) { if (o !== p) o.classList.remove("open"); });
      var open = !p.classList.contains("open"); p.classList.toggle("open", open); b.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) { if (!p.contains(e.target) && e.target !== b) { p.classList.remove("open"); b.setAttribute("aria-expanded", "false"); } });
  }
  function wireUI() {
    $("search").addEventListener("input", function (e) { S.query = e.target.value; renderList(); });
    // Picker: arrow keys preview layers live; click, Enter or Escape closes it.
    $("layer-btn").addEventListener("click", function (e) { e.stopPropagation(); openPicker($("layer-pop").hidden); });
    $("layer-pop").addEventListener("change", function (e) { if (e.target.name === "layer") setLayer(e.target.value); });
    $("layer-pop").addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest(".pk-opt") && e.detail > 0) { setTimeout(function () { openPicker(false); $("layer-btn").focus(); }, 0); }
    });
    $("layer-pop").addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); openPicker(false); $("layer-btn").focus(); }
    });
    document.addEventListener("click", function (e) { if (!$("layer-pop").hidden && !e.target.closest(".picker")) openPicker(false); });
    $("sort-best").addEventListener("click", function () { S.bestFirst = true; renderList(); });
    $("sort-worst").addEventListener("click", function () { S.bestFirst = false; renderList(); });
    $("fav-only").addEventListener("change", function (e) { S.favOnly = e.target.checked; renderList(); });
    $("list").addEventListener("click", function (e) { var b = e.target.closest("button[data-geoid]"); if (b) openProfile(b.dataset.geoid); });
    $("close-drawer").addEventListener("click", closeProfile);
    $("fav-btn").addEventListener("click", toggleFavorite);
    $("cmp-btn").addEventListener("click", function () { toggleCompare(S.selected); });
    $("dl-town").addEventListener("click", function () { var r = D.byId[S.selected]; if (r) download("openhousing_" + slug(r.name) + ".csv", csvFor([r])); });
    $("dl-compare").addEventListener("click", function () {
      var rows = S.compare.map(function (g) { return D.byId[g]; }).filter(Boolean);
      if (rows.length) download("openhousing_comparison_" + rows.map(function (r) { return slug(r.name); }).join("_") + ".csv", csvFor(rows));
    });
    $("reset-view").addEventListener("click", resetView);
    $("retry").addEventListener("click", function () { if (!map) initMap(); else loadBounds(); });
    document.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () { if (!$("drawer").hidden) closeProfile(); setView(b.dataset.view); });
    });
    document.querySelector(".skip").addEventListener("click", function (e) { e.preventDefault(); setView("table"); var t = document.querySelector("#table-view .tablewrap"); if (t) t.focus(); });
    $("tsearch").addEventListener("input", function (e) { S.tquery = e.target.value; renderTable(); });
    $("table").addEventListener("click", function (e) {
      var s = e.target.closest("button[data-sort]");
      if (s) { var c = s.dataset.sort; if (S.sortCol === c) S.sortAsc = !S.sortAsc; else { S.sortCol = c; S.sortAsc = !/score/.test(c); } renderTable();
               var nb = document.querySelector('#table button[data-sort="' + c + '"]'); if (nb) nb.focus(); return; }
      var o = e.target.closest("button[data-open]"); if (o) openProfile(o.dataset.open, false);
    });
    $("compare-wrap").addEventListener("click", function (e) {
      var rm = e.target.closest("button[data-remove]"); if (rm) { toggleCompare(rm.dataset.remove); return; }
      var o = e.target.closest("button[data-open]"); if (o) openProfile(o.dataset.open, false);
    });
    wirePopover("snap-btn", "snap-pop");
    wirePopover("sources-btn", "sources-pop");
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!tipEl.hidden) { hideTip(); return; }
      if (!$("layer-pop").hidden) { openPicker(false); $("layer-btn").focus(); return; }
      var open = document.querySelector(".popover.open");
      if (open) { open.classList.remove("open"); var b = document.querySelector('[aria-controls="' + open.id + '"]'); if (b) { b.setAttribute("aria-expanded", "false"); b.focus(); } }
      else if (!$("drawer").hidden) closeProfile();
    });
    $("theme-btn").addEventListener("click", function () {
      var t = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("oh-theme", t); } catch (e) {}
      if (D.rows.length) { renderList(); renderLegend(); renderSnapshot(); fillLayerSelect(); if (S.selected) openProfile(S.selected, false); }
      if (map) { mapReady = false; styleOk = false; map.setStyle(styleUrl()); }   // style.load re-adds the layers
    });
  }

  // ------------------------------------------------------------------ mobile bottom sheet
  // Below 860px the list is a bottom sheet over a full-screen map with three
  // heights: peek (search + layer), half, full. Drag the handle or tap it to cycle.
  var SHEET = { state: "peek" };
  var mobile = window.matchMedia("(max-width: 860px)");
  function sheetHeights() {
    var vh = window.innerHeight, top = document.querySelector(".bar").offsetHeight;
    var peek = $("sheet-handle").offsetHeight + document.querySelector(".side-top").offsetHeight + 4;
    return { peek: peek, half: Math.round(vh * 0.52), full: vh - top - 8 };
  }
  function setSheet(state, animate) {
    if (!mobile.matches) { $("side").style.height = ""; return; }
    SHEET.state = state;
    var side = $("side");
    side.classList.toggle("dragging", animate === false);
    side.style.height = sheetHeights()[state] + "px";
    side.dataset.sheet = state;
    $("sheet-handle").setAttribute("aria-label", state === "full" ? "Collapse the list" : "Show more of the list");
  }
  function wireSheet() {
    var h = $("sheet-handle"), side = $("side"), startY = 0, startH = 0, moved = false;
    h.addEventListener("click", function () {
      if (moved) { moved = false; return; }
      setSheet(SHEET.state === "peek" ? "half" : SHEET.state === "half" ? "full" : "peek");
    });
    h.addEventListener("pointerdown", function (e) {
      if (!mobile.matches) return;
      startY = e.clientY; startH = side.offsetHeight; moved = false;
      h.setPointerCapture(e.pointerId); side.classList.add("dragging");
    });
    h.addEventListener("pointermove", function (e) {
      if (!h.hasPointerCapture(e.pointerId)) return;
      var dy = e.clientY - startY; if (Math.abs(dy) > 4) moved = true;
      var hs = sheetHeights();
      side.style.height = Math.max(hs.peek, Math.min(hs.full, startH - dy)) + "px";
    });
    h.addEventListener("pointerup", function (e) {
      if (!h.hasPointerCapture(e.pointerId)) return;
      h.releasePointerCapture(e.pointerId); side.classList.remove("dragging");
      if (!moved) return;
      var cur = side.offsetHeight, hs = sheetHeights(), best = "peek";
      ["peek", "half", "full"].forEach(function (k) { if (Math.abs(hs[k] - cur) < Math.abs(hs[best] - cur)) best = k; });
      setSheet(best);
    });
    $("search").addEventListener("focus", function () { if (mobile.matches && SHEET.state === "peek") setSheet("half"); });
    window.addEventListener("resize", function () { setSheet(SHEET.state); });
    (mobile.addEventListener ? mobile.addEventListener("change", function () { setSheet("peek"); }) : null);
    setSheet("peek");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
