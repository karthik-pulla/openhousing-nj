/* OpenHousing NJ v2 map app. Plain JavaScript, no build step.
 *
 * Reads only published, validated files:
 *   ../data/published/openhousing_nj.web.json     one row per municipality (same columns as the CSV)
 *   ../data/published/summaries.web.json          template summaries, each statistic tagged with its sources
 *   ../data/published/home_value_history.web.json ACS 5-year median home value by release (profile graph)
 *   ../data/published/affordability_history.web.json price- and rent-to-income by ACS release (profile graph)
 *   ../data/published/town_changes.web.json       tracked fields per town in every archived release (History)
 *   ../data/published/regions.web.json            county, housing-region and statewide summaries (Regions view)
 *   ../data/archive/index.json                    dated releases and what changed in each
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
    trend: "../data/published/affordability_history.web.json",
    changes: "../data/published/town_changes.web.json",
    regions: "../data/published/regions.web.json",
    archive: "../data/archive/index.json",
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
  function yesno(v) { return has(v) ? (isTrue(v) || v === 1 || v === "1" ? "Yes" : "No") : UNAV; }
  function ratio(v) { return has(v) ? num(v, 1) + "×" : UNAV; }
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
    { group: "Cost compared with income", key: "price_to_income", label: "Home price vs. income", sub: "Years of town income the typical home costs", scheme: "div", invert: true,
      fmt: ratio, better: "low", best: "Fewest years", worst: "Most years", ends: ["More years", "Fewer years"],
      desc: "Typical home value divided by the town's median household income (v1's price-to-income ratio). Context only: not part of either score." },
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
      ["dca_equalized_avg_res_value", "State-assessed average value", money, "property_tax_municipal", "NJ DCA average residential assessment divided by the town's equalization ratio. An average, not a median; for comparison."],
      ["price_to_income", "Home value ÷ town income", ratio, "derived", "Years of town median household income the typical home costs (v1's measure). Not part of the score."],
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
      ["nzlud_adu", "Accessory units allowed", yesno, "nzlud_municipal", "Whether accessory dwelling units are allowed anywhere in the town (NZLUD)."],
      ["nzlud_parking_median", "Parking required per home", function (v) { return num(v, 1); }, "nzlud_municipal", "Median number of parking spaces required per residential unit (NZLUD)."],
      ["nzlud_mf_per", "Districts allowing apartments", pct, "nzlud_municipal", "Share of residential districts that allow multifamily housing by right (NZLUD)."],
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
    acs_home_value_history: "U.S. Census Bureau, ACS 5-year (B25077)", acs_rent_history: "U.S. Census Bureau, ACS 5-year (B25064)",
    acs_income_history: "U.S. Census Bureau, ACS 5-year (county and state)" };

  // ------------------------------------------------------------------ state
  var D = { rows: [], byId: {}, cols: [], manifest: null, summaries: null, history: null, sources: {},
            trend: null, changes: null, archive: null, regions: null, pub: {} };
  var S = { layer: "ownership_score", bestFirst: true, query: "", favOnly: false, selected: null,
            view: "map", compare: [], sortCol: "ownership_rank", sortAsc: true, tquery: "",
            adv: null, trendMode: "own", cx: "town_median_hh_income", cy: "ownership_score", ccounty: "", cregion: "", clog: false,
            rlevel: "county", rsort: "name", rasc: true };
  var VIEWS = ["map", "table", "chart", "regions", "compare"];
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
      D.rows.forEach(function (r) {
        r.geoid = String(r.geoid); D.byId[r.geoid] = r;
        var keep = {}; ADV_FIELDS.forEach(function (f) { keep[f] = r[f]; }); D.pub[r.geoid] = keep;
      });
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
      '<div class="sb-r">' + (has(r[rankKey]) ? "Rank " + r[rankKey] + " of " + n : "Not scored") + rangeTxt(r, rankKey) + "</div></div></div>" +
      badge(r[confKey], r[reasonKey]) + "</div>";
  }

  function rangeTxt(r, rankKey) {
    var lo = r[rankKey + "_low"], hi = r[rankKey + "_high"];
    if (S.adv || !has(lo) || !has(hi) || !has(r[rankKey])) return "";
    var a = D.manifest.assumptions || {};
    return '<span class="rr" tabindex="0" data-tip="' + esc("Likely rank range: " + lo + " to " + hi + ". The Census figures behind this score are survey estimates with margins of error. " +
      "Redrawing them 1,000 times within those margins puts this town between rank " + lo + " and " + hi + " in 90% of draws. A narrow range means a dependable rank.") + '">likely ' + lo + "–" + hi + "</span>";
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
    var html = (S.adv ? '<p class="adv-note">Custom assumptions are on: ' + esc(advLabel(S.adv)) + ". Scores, ranks and costs below use them; the plain-English summary uses the published assumptions. " +
      '<button type="button" class="linkbtn" data-adv-reset>Reset</button></p>' : "") + '<div class="scores">' +
      scoreBlock("Owning", "ownership_score", "ownership_rank", "ownership_confidence", "ownership_confidence_reasons", r, nOwn) +
      scoreBlock("Renting", "rental_score", "rental_rank", "rental_confidence", "rental_confidence_reasons", r, nRent) + "</div>" +
      '<p class="higher">Higher is more affordable ' + info("Scores are percentiles across New Jersey towns (100 = smallest share of county income). Assumes " +
        a.down_payment_pct + "% down, " + a.loan_term_years + "-year fixed at " + num(a.mortgage_rate_pct, 2) + "%. Excludes " + (a.excluded_costs || []).join(", ") + ".", "How scores work") + "</p>";
    html += '<section class="chart-sec"><h3>Home value <span id="hv-range"></span> ' + info("Census ACS 5-year median value of owner-occupied homes (owners' own estimates). Each point is a five-year period ending in that year (2009 = 2005–2009) and overlaps the next, in dollars of that period's final year, not adjusted to today. The shaded band is the survey's margin of error (90% confidence): the range the true value very likely falls in.", "About this graph") +
      '</h3><div id="hv-chart" class="hv"></div></section>';
    html += '<section class="chart-sec"><h3>Affordability over time ' + info("How the typical home's value (Owning) or a year of median rent (Renting) compares with the county's median household income, in every Census ACS 5-year release. " +
      "Both figures come from the same release, so each point is a like-for-like five-year period. The dashed line is New Jersey as a whole (the state's own medians). Points overlap by four years, so changes are gradual.", "About this graph") +
      '<span class="seg mini" role="group" aria-label="Measure"><button type="button" class="segb" data-trend="own" aria-pressed="' + (S.trendMode === "own") + '">Owning</button>' +
      '<button type="button" class="segb" data-trend="rent" aria-pressed="' + (S.trendMode === "rent") + '">Renting</button></span></h3><div id="tr-chart" class="hv"></div></section>';
    html += '<h3>In plain English</h3><div class="summary" id="p-summary">' + (D.summaries ? "" : "Loading summary…") + "</div>";
    SECTIONS.forEach(function (sec) {
      html += "<h3>" + esc(sec.title) + '</h3><dl class="kv">';
      sec.rows.forEach(function (row) {
        var v = r[row[0]], txt = row[2](v);
        html += '<div><dt data-tip="' + esc(srcTip(row[3], r, row[4])) + '" tabindex="0">' + esc(row[1]) + "</dt><dd" + (txt === UNAV ? ' class="na"' : "") + ">" + esc(txt) + "</dd></div>";
      });
      html += "</dl>";
    });
    html += '<div class="hist"><button type="button" class="hist-btn" id="hist-btn" aria-expanded="false" aria-controls="hist-body">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>Release history</button>' +
      '<div class="hist-body" id="hist-body" hidden></div></div>';
    $("d-body").innerHTML = html;
    $("d-body").scrollTop = 0;
    fillSummary(r);
    fillHistory(r);
    fillTrend(r);
    $("p-name").focus();
    if (zoom !== false) zoomTo(geoid);
    repaint(); markListSelection(); writeHash();
  }

  // Summary sentence template id -> section heading
  var SUMMARY_GROUP = {
    home_value: "Owning", home_value_topcoded: "Owning", home_value_missing: "Owning", home_value_dca: "Owning", ownership_cost: "Owning",
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
    ["home_value", "Home value", money], ["price_to_income", "Price ÷ income", ratio], ["median_gross_rent", "Median rent", rentMoney],
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
    var lines = [D.cols.join(",")].concat(rows.map(function (r) { return D.cols.map(function (c) { return q(r[c]); }).join(","); }));
    // With custom assumptions on, the costs, burdens, scores and ranks are the custom ones: say so in the file.
    if (S.adv) lines.push("# custom assumptions (not the published dataset): " + advLabel(S.adv));
    return lines.join("\n") + "\n";
  }
  function download(name, text) {
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

  // ------------------------------------------------------------------ affordability over time (profile)
  function fillTrend(r) {
    var go = function () {
      var el = $("tr-chart"); if (!el || S.selected !== r.geoid) return;
      var T = D.trend, own = S.trendMode === "own", k = own ? 0 : 1;
      var rows = T.towns[r.geoid] || [];
      var pts = [], st = [];
      T.years.forEach(function (y, i) {
        var p = rows[i]; if (p && has(p[k])) pts.push({ y: y, v: p[k], top: own ? (p[2] & 1) : (p[2] & 2) });
        var q = T.state[i]; if (q && has(q[k])) st.push({ y: y, v: q[k] });
      });
      if (pts.length < 2) { el.innerHTML = '<p class="na">Unavailable</p>'; return; }
      st = st.filter(function (p) { return p.y >= pts[0].y && p.y <= pts[pts.length - 1].y; });   // same years as the town
      var f = own ? function (v) { return num(v, 1) + "×"; } : function (v) { return pct(v); };
      var W = Math.max(240, Math.round(el.clientWidth || 380)), Ht = 124, pl = 4, pr = 6, pt = 22, pb = 20;
      var all = pts.concat(st), lo = Math.min.apply(null, all.map(function (p) { return p.v; })), hi = Math.max.apply(null, all.map(function (p) { return p.v; }));
      var pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
      var x0 = Math.min(pts[0].y, st.length ? st[0].y : pts[0].y), x1 = Math.max(pts[pts.length - 1].y, st.length ? st[st.length - 1].y : 0);
      var X = function (y) { return pl + (y - x0) / ((x1 - x0) || 1) * (W - pl - pr); };
      var Y = function (v) { return pt + (1 - (v - lo) / ((hi - lo) || 1)) * (Ht - pt - pb); };
      var first = pts[0], last = pts[pts.length - 1];
      el.innerHTML = '<svg viewBox="0 0 ' + W + " " + Ht + '" role="img" aria-label="' + esc((own ? "Home value as a multiple of county income" : "A year of rent as a share of county income") +
        ": " + f(first.v) + " in " + (first.y - 4) + "–" + first.y + ", " + f(last.v) + " in " + (last.y - 4) + "–" + last.y) + '">' +
        (st.length > 1 ? '<path class="tr-state" d="' + smoothPath(st.map(function (p) { return [X(p.y), Y(p.v)]; })) + '"/>' : "") +
        '<path class="hv-line" d="' + smoothPath(pts.map(function (p) { return [X(p.y), Y(p.v)]; })) + '"/>' +
        '<circle class="hv-end" cx="' + X(last.y) + '" cy="' + Y(last.v) + '" r="3.5"/>' +
        '<text class="hv-lbl" x="' + X(first.y) + '" y="12">' + f(first.v) + '</text>' +
        '<text class="hv-lbl" x="' + X(last.y) + '" y="12" text-anchor="end">' + f(last.v) + "</text>" +
        '<text class="hv-ax" x="' + X(first.y) + '" y="' + (Ht - 4) + '">' + first.y + '</text>' +
        '<text class="hv-ax" x="' + X(last.y) + '" y="' + (Ht - 4) + '" text-anchor="end">' + last.y + "</text>" +
        '<line class="hv-x" y1="' + pt + '" y2="' + (Ht - pb) + '" x1="0" x2="0" visibility="hidden"/><circle class="hv-dot" r="4" cx="0" cy="0" visibility="hidden"/></svg>' +
        '<div class="hv-read" aria-live="polite"></div>' +
        '<div class="hv-key"><span><i class="k-line"></i>' + esc(r.name) + '</span><span><i class="k-dash"></i>New Jersey</span></div>';
      var svg = el.querySelector("svg"), xl = el.querySelector(".hv-x"), dot = el.querySelector(".hv-dot"), read = el.querySelector(".hv-read");
      var stBy = {}; st.forEach(function (p) { stBy[p.y] = p.v; });
      var showAt = function (i) {
        var p = pts[i]; xl.setAttribute("x1", X(p.y)); xl.setAttribute("x2", X(p.y)); dot.setAttribute("cx", X(p.y)); dot.setAttribute("cy", Y(p.v));
        xl.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
        read.textContent = (p.y - 4) + "–" + p.y + ": " + (p.top ? "at least " : "") + f(p.v) + (own ? " county income" : " of county income") +
          (has(stBy[p.y]) ? " · New Jersey " + f(stBy[p.y]) : "");
      };
      var clear = function () { xl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); read.textContent = ""; };
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
    if (D.trend) return go();
    getJSON(PATHS.trend).then(function (t) { D.trend = t; go(); })
      .catch(function () { var el = $("tr-chart"); if (el) el.innerHTML = '<p class="na">Unavailable</p>'; });
  }

  // ------------------------------------------------------------------ release history (profile, behind a small button)
  var CHANGE_LABELS = {
    ownership_score: ["Ownership score", function (v) { return num(v, 1); }], ownership_rank: ["Ownership rank", function (v) { return num(v); }],
    rental_score: ["Rental score", function (v) { return num(v, 1); }], rental_rank: ["Rental rank", function (v) { return num(v); }],
    home_value: ["Typical home value", money], home_value_source: ["Home value source", String], home_value_vintage: ["Home value data period", String],
    median_gross_rent: ["Median rent", rentMoney], avg_property_tax_bill: ["Property tax", money], tax_year: ["Tax year", String],
    mortgage_rate_pct: ["Mortgage rate", function (v) { return num(v, 2) + "%"; }], county_median_hh_income: ["County median income", money],
    ownership_burden: ["Cost to own ÷ county income", function (v) { return pct(v, 1); }], rent_burden: ["Rent ÷ county income", function (v) { return pct(v, 1); }],
    ownership_confidence: ["Ownership confidence", String], rental_confidence: ["Rental confidence", String],
    present_need: ["Present need", function (v) { return num(v); }], prospective_need_capped: ["Prospective need", function (v) { return num(v); }]
  };
  function renderTownHistory(geoid) {
    var body = $("hist-body"); if (!body) return;
    var C = D.changes, A = D.archive, series = C.towns[geoid] || [];
    var byRel = {}; (A.releases || []).forEach(function (e) { byRel[e.release] = e; });
    var html = "", F = C.fields;
    for (var i = C.releases.length - 1; i >= 0; i--) {
      var rel = C.releases[i], cur = series[i], prev = i > 0 ? series[i - 1] : null, e = byRel[rel];
      html += '<div class="rel"><div class="rel-h"><b>' + esc(fmtDate(rel + "T12:00:00")) + "</b>" +
        (e ? ' <a href="../' + esc(e.csv) + '" download>Download this release</a>' : "") + "</div>";
      if (!cur) { html += '<p class="muted">Not in this release.</p></div>'; continue; }
      if (!prev) {
        html += '<p class="muted">' + (i === 0 ? "First archived release. Changes will be listed here after the next monthly update." : "Not in the previous release.") + "</p>";
      } else {
        var ch = [];
        F.forEach(function (f, j) {
          var a = prev[j], b = cur[j], L = CHANGE_LABELS[f]; if (!L) return;
          var same = (!has(a) && !has(b)) || (has(a) && has(b) && (typeof a === "number" ? Math.abs(a - b) < 1e-9 : String(a) === String(b)));
          if (!same) ch.push("<li><span>" + esc(L[0]) + "</span><span>" + esc(has(a) ? L[1](a) : UNAV) + " → " + esc(has(b) ? L[1](b) : UNAV) + "</span></li>");
        });
        html += ch.length ? '<ul class="chg">' + ch.join("") + "</ul>" : '<p class="muted">No change for this town.</p>';
      }
      html += "</div>";
    }
    html += '<p class="muted small">Every monthly release is archived. <a href="data.html#archive">All releases and the changelog</a></p>';
    body.innerHTML = html;
  }
  function toggleTownHistory() {
    var b = $("hist-btn"), body = $("hist-body"), g = S.selected; if (!b || !g) return;
    var open = body.hidden; body.hidden = !open; b.setAttribute("aria-expanded", String(open));
    if (!open) return;
    if (D.changes && D.archive) { renderTownHistory(g); return; }
    body.innerHTML = '<p class="muted">Loading…</p>';
    Promise.all([getJSON(PATHS.changes), getJSON(PATHS.archive)]).then(function (res) {
      D.changes = res[0]; D.archive = res[1]; if (S.selected === g) renderTownHistory(g);
    }).catch(function () { body.innerHTML = '<p class="muted">Release history couldn’t be loaded.</p>'; });
  }

  // ------------------------------------------------------------------ advanced: custom assumptions
  // Recalculates costs, burdens, scores and ranks in the browser with the same formulas
  // as the pipeline (amortized mortgage + property tax; Hazen percentile; rank by score).
  var ADV_FIELDS = ["annual_mortgage_pi", "annual_ownership_cost", "ownership_burden", "rent_burden", "ownership_burden_ami80",
                    "ownership_affordable_at_ami80", "ownership_score", "ownership_rank", "rental_score", "rental_rank", "mortgage_rate_pct"];
  var BASIS = { county: "county median income", town: "town median income", ami80: "HUD 80% income limit (family of four)" };
  function advDefaults() {
    var a = (D.manifest && D.manifest.assumptions) || {};
    return { dp: Number(a.down_payment_pct), rate: Number(a.mortgage_rate_pct), term: Number(a.loan_term_years), basis: "county", tax: true };
  }
  function advLabel(a) {
    return a.dp + "% down, " + num(a.rate, 2) + "% rate, " + a.term + "-year loan, " + BASIS[a.basis] + (a.tax ? "" : ", property tax left out");
  }
  function sameAdv(a, b) { return a.dp === b.dp && Math.abs(a.rate - b.rate) < 1e-9 && a.term === b.term && a.basis === b.basis && a.tax === b.tax; }
  function amort(price, rate, dp, term) {
    var loan = price * (1 - dp / 100), i = rate / 100 / 12, n = 12 * term;
    return i === 0 ? 12 * loan / n : 12 * loan * i / (1 - Math.pow(1 + i, -n));
  }
  function scoreAndRank(rows, burdenKey, scoreKey, rankKey) {
    var have = rows.filter(function (r) { return has(r[burdenKey]); }).sort(function (a, b) { return a[burdenKey] - b[burdenKey]; });
    var n = have.length, i = 0;
    rows.forEach(function (r) { r[scoreKey] = null; r[rankKey] = null; });
    while (i < n) {                                   // average rank for ties (Hazen percentile)
      var j = i; while (j + 1 < n && have[j + 1][burdenKey] === have[i][burdenKey]) j++;
      var avg = (i + j) / 2 + 1, pctl = (avg - 0.5) / n * 100;
      for (var k = i; k <= j; k++) have[k][scoreKey] = 100 - pctl;           // 100 = smallest burden
      i = j + 1;
    }
    var byScore = have.slice().sort(function (a, b) { return b[scoreKey] - a[scoreKey]; });
    byScore.forEach(function (r, idx) { r[rankKey] = (idx > 0 && byScore[idx - 1][scoreKey] === r[scoreKey]) ? byScore[idx - 1][rankKey] : idx + 1; });
  }
  function applyAssumptions(a) {
    var d = advDefaults();
    if (!a || sameAdv(a, d)) { resetAssumptions(); return; }
    S.adv = a;
    D.rows.forEach(function (r) {
      var inc = a.basis === "town" ? r.town_median_hh_income : a.basis === "ami80" ? r.ami80_income_limit : r.county_median_hh_income;
      var tax = a.tax ? r.avg_property_tax_bill : 0;
      var mort = has(r.home_value) ? amort(r.home_value, a.rate, a.dp, a.term) : null;
      var cost = has(mort) && has(tax) ? mort + tax : null;
      r.mortgage_rate_pct = a.rate;
      r.annual_mortgage_pi = mort;
      r.annual_ownership_cost = cost;
      r.ownership_burden = has(cost) && has(inc) && inc > 0 ? cost / inc : null;
      r.rent_burden = has(r.annual_rent) && has(inc) && inc > 0 ? r.annual_rent / inc : null;
      r.ownership_burden_ami80 = has(cost) && has(r.ami80_income_limit) ? cost / r.ami80_income_limit : null;
      r.ownership_affordable_at_ami80 = has(r.ownership_burden_ami80) ? r.ownership_burden_ami80 <= 0.30 : null;
    });
    scoreAndRank(D.rows, "ownership_burden", "ownership_score", "ownership_rank");
    scoreAndRank(D.rows, "rent_burden", "rental_score", "rental_rank");
    afterAssumptions();
  }
  function resetAssumptions() {
    S.adv = null;
    D.rows.forEach(function (r) { var k = D.pub[r.geoid]; ADV_FIELDS.forEach(function (f) { r[f] = k[f]; }); });
    afterAssumptions();
  }
  function afterAssumptions() {
    classCache = {};
    var chip = $("adv-chip"); chip.hidden = !S.adv;
    if (S.adv) $("adv-chip-t").textContent = "Custom: " + advLabel(S.adv);
    fillAdvForm(S.adv || advDefaults());
    renderList(); renderLegend(); repaint(); renderSnapshot();
    if (S.view === "table") renderTable();
    if (S.view === "chart") renderChart();
    renderCompare();
    if (S.selected) openProfile(S.selected, false);
    writeHash();
  }
  function fillAdvForm(a) {
    $("adv-dp").value = a.dp; $("adv-dp-n").value = a.dp;
    $("adv-rate").value = a.rate; $("adv-rate-n").value = a.rate;
    $("adv-term").value = String(a.term);
    document.querySelectorAll('input[name="adv-basis"]').forEach(function (i) { i.checked = i.value === a.basis; });
    $("adv-tax").checked = a.tax;
  }
  function readAdvForm() {
    var basis = "county"; document.querySelectorAll('input[name="adv-basis"]').forEach(function (i) { if (i.checked) basis = i.value; });
    var dp = Math.min(100, Math.max(0, Number($("adv-dp-n").value))), rate = Math.min(20, Math.max(0, Number($("adv-rate-n").value)));
    return { dp: isNaN(dp) ? 20 : dp, rate: isNaN(rate) ? advDefaults().rate : Math.round(rate * 1000) / 1000, term: Number($("adv-term").value), basis: basis, tax: $("adv-tax").checked };
  }
  var advTimer = null;
  function wireAdvanced() {
    var pairs = [["adv-dp", "adv-dp-n"], ["adv-rate", "adv-rate-n"]];
    pairs.forEach(function (p) {
      $(p[0]).addEventListener("input", function () { $(p[1]).value = $(p[0]).value; schedule(); });
      $(p[1]).addEventListener("input", function () { $(p[0]).value = $(p[1]).value; schedule(); });
    });
    ["adv-term", "adv-tax"].forEach(function (id) { $(id).addEventListener("change", schedule); });
    document.querySelectorAll('input[name="adv-basis"]').forEach(function (i) { i.addEventListener("change", schedule); });
    $("adv-reset").addEventListener("click", function () { resetAssumptions(); });
    $("adv-chip-reset").addEventListener("click", function () { resetAssumptions(); });
    document.addEventListener("click", function (e) { if (e.target.closest("[data-adv-reset]")) resetAssumptions(); });
    function schedule() { clearTimeout(advTimer); advTimer = setTimeout(function () { applyAssumptions(readAdvForm()); }, 120); }
  }
  function advToHash() { var a = S.adv; return a ? [a.dp, a.rate, a.term, a.basis, a.tax ? 1 : 0].join("_") : ""; }
  function advFromHash(v) {
    var p = String(v || "").split("_"); if (p.length !== 5 || !BASIS[p[3]]) return null;
    var a = { dp: Number(p[0]), rate: Number(p[1]), term: Number(p[2]), basis: p[3], tax: p[4] === "1" };
    return (isNaN(a.dp) || isNaN(a.rate) || [15, 20, 30].indexOf(a.term) < 0) ? null : a;
  }

  // ------------------------------------------------------------------ chart view: any two measures
  var MEASURES = [
    ["ownership_score", "Ownership score", function (v) { return num(v, 1); }],
    ["rental_score", "Rental score", function (v) { return num(v, 1); }],
    ["ownership_burden", "Cost to own ÷ county income", function (v) { return pct(v); }],
    ["rent_burden", "Rent ÷ county income", function (v) { return pct(v); }],
    ["price_to_income", "Home value ÷ town income", ratio],
    ["home_value", "Typical home value", money],
    ["median_gross_rent", "Median rent", rentMoney],
    ["avg_property_tax_bill", "Average property tax", money],
    ["town_median_hh_income", "Town median income", money],
    ["county_median_hh_income", "County median income", money],
    ["renters_cost_burdened_share", "Renters paying 30%+", function (v) { return pct(v); }],
    ["population", "Population", function (v) { return num(v); }],
    ["zri", "Zoning restrictiveness (105 towns)", function (v) { return num(v, 2); }],
    ["nzlud_mf_per", "Districts allowing apartments (105 towns)", function (v) { return pct(v); }],
    ["nzlud_parking_median", "Parking required per home (105 towns)", function (v) { return num(v, 1); }],
    ["present_need", "Present need", function (v) { return num(v); }],
    ["prospective_need_per_1000_hh", "Prospective need per 1,000 households", function (v) { return num(v, 1); }],
    ["total_need_per_1000_hh", "Total need per 1,000 households", function (v) { return num(v, 1); }],
    ["dca_equalized_avg_res_value", "State-assessed average value", money]
  ];
  var MBY = {}; MEASURES.forEach(function (m) { MBY[m[0]] = m; });
  function fillChartControls() {
    var opts = MEASURES.map(function (m) { return '<option value="' + m[0] + '">' + esc(m[1]) + "</option>"; }).join("");
    $("cx").innerHTML = opts; $("cy").innerHTML = opts;
    $("cx").value = S.cx; $("cy").value = S.cy;
    var counties = []; D.rows.forEach(function (r) { if (counties.indexOf(r.county) < 0) counties.push(r.county); });
    counties.sort();
    $("ccounty").innerHTML = '<option value="">All counties</option>' + counties.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + " County</option>"; }).join("");
    var regs = {}; D.rows.forEach(function (r) { if (has(r.housing_region)) { var k = String(r.housing_region); (regs[k] = regs[k] || []).indexOf(r.county) < 0 && regs[k].push(r.county); } });
    $("cregion").innerHTML = '<option value="">All housing regions</option>' + Object.keys(regs).sort().map(function (k) {
      return '<option value="' + k + '">Region ' + k + " (" + esc(regs[k].sort().join(", ")) + ")</option>"; }).join("");
    $("ccounty").value = S.ccounty; $("cregion").value = S.cregion; $("clog").checked = S.clog;
  }
  function chartRows() {
    return D.rows.filter(function (r) {
      if (S.ccounty && r.county !== S.ccounty) return false;
      if (S.cregion && String(r.housing_region) !== S.cregion) return false;
      var x = r[S.cx], y = r[S.cy];
      if (!has(x) || !has(y)) return false;
      if (S.clog && (x <= 0 || y <= 0)) return false;
      return true;
    });
  }
  function rankArr(a) {
    var idx = a.map(function (v, i) { return [v, i]; }).sort(function (p, q) { return p[0] - q[0]; }), out = [], i = 0;
    while (i < idx.length) { var j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (var k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
    return out;
  }
  function pearson(x, y) {
    var n = x.length; if (n < 3) return null;
    var mx = x.reduce(function (s, v) { return s + v; }, 0) / n, my = y.reduce(function (s, v) { return s + v; }, 0) / n, sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function niceTicks(lo, hi, n) {
    var span = hi - lo || Math.abs(hi) || 1, step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var t = [], v = Math.ceil(lo / step) * step; for (; v <= hi + step * 1e-9; v += step) t.push(+v.toFixed(10)); return t;
  }
  function logTicks(lo, hi) {
    var t = []; for (var e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, e); if (v >= lo && v <= hi) t.push(v); });
    return t.length >= 2 ? t : [lo, hi];
  }
  function renderChart() {
    var el = $("scatter"); if (!el) return;
    var mx = MBY[S.cx], my = MBY[S.cy], rows = chartRows();
    var xs = rows.map(function (r) { return Number(r[S.cx]); }), ys = rows.map(function (r) { return Number(r[S.cy]); });
    var stats = $("sc-stats");
    if (rows.length < 2) { el.innerHTML = '<p class="hint">Not enough towns have both values with these filters.</p>'; stats.textContent = ""; return; }
    var rs = pearson(rankArr(xs), rankArr(ys)), rp = pearson(xs, ys);
    stats.innerHTML = "<b>" + rows.length + "</b> towns with both values · Spearman rank correlation <b>" + (has(rs) ? num(rs, 2) : "–") +
      "</b> · Pearson <b>" + (has(rp) ? num(rp, 2) : "–") + "</b>" + (S.adv ? " · custom assumptions on" : "") +
      ' <span class="muted">A correlation shows two measures move together, not that one causes the other.</span>';
    var W = Math.max(320, el.clientWidth || 700), H = Math.max(300, Math.min(520, Math.round(W * 0.6))), ml = 62, mr = 16, mt = 12, mb = 44;
    var tf = S.clog ? Math.log10 : function (v) { return v; };
    var xl = Math.min.apply(null, xs), xh = Math.max.apply(null, xs), yl = Math.min.apply(null, ys), yh = Math.max.apply(null, ys);
    var xt = S.clog ? logTicks(xl, xh) : niceTicks(xl, xh, 6), yt = S.clog ? logTicks(yl, yh) : niceTicks(yl, yh, 5);
    var X0 = Math.min(tf(xl), tf(xt[0])), X1 = Math.max(tf(xh), tf(xt[xt.length - 1])), Y0 = Math.min(tf(yl), tf(yt[0])), Y1 = Math.max(tf(yh), tf(yt[yt.length - 1]));
    var px = function (v) { return ml + (tf(v) - X0) / ((X1 - X0) || 1) * (W - ml - mr); };
    var py = function (v) { return mt + (1 - (tf(v) - Y0) / ((Y1 - Y0) || 1)) * (H - mt - mb); };
    var short = function (m, v) { var s = m[2](v); return s.length > 9 && typeof v === "number" && Math.abs(v) >= 1000 ? (v >= 1e6 ? "$" + num(v / 1e6, 1) + "M" : (m[2] === money ? "$" : "") + num(v / 1000, 0) + "k") : s; };
    var g = "";
    xt.forEach(function (t) { var x = px(t); g += '<line class="sc-grid" x1="' + x + '" x2="' + x + '" y1="' + mt + '" y2="' + (H - mb) + '"/><text class="sc-tk" x="' + x + '" y="' + (H - mb + 16) + '" text-anchor="middle">' + esc(short(mx, t)) + "</text>"; });
    yt.forEach(function (t) { var y = py(t); g += '<line class="sc-grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y + '" y2="' + y + '"/><text class="sc-tk" x="' + (ml - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(short(my, t)) + "</text>"; });
    var dots = rows.map(function (r, i) {
      return '<circle class="sc-pt' + (r.geoid === S.selected ? " sel" : "") + '" cx="' + px(xs[i]).toFixed(1) + '" cy="' + py(ys[i]).toFixed(1) + '" r="4" fill="' + scoreColor("ownership_score", r.ownership_score) + '"/>';
    }).join("");
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc("Scatter plot of " + my[1] + " against " + mx[1] + " for " + rows.length + " towns. Download the points for the full data.") + '">' +
      g + '<line class="sc-axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (H - mb) + '" y2="' + (H - mb) + '"/>' +
      '<text class="sc-lab" x="' + (ml + (W - ml - mr) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(mx[1]) + (S.clog ? " (log scale)" : "") + "</text>" +
      '<text class="sc-lab" transform="translate(14 ' + (mt + (H - mt - mb) / 2) + ') rotate(-90)" text-anchor="middle">' + esc(my[1]) + (S.clog ? " (log scale)" : "") + "</text>" +
      '<g class="sc-pts">' + dots + "</g></svg>" +
      '<div class="sc-key">Dots are colored by ownership score: ' + palette(LAYER_BY_KEY.ownership_score).map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("") + " less to more affordable. Click a dot to open the town.</div>";
    var svg = el.querySelector("svg"), tip = $("sc-tip"), circles = svg.querySelectorAll(".sc-pt");
    var nearest = function (e) {
      var b = svg.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W, y = (e.clientY - b.top) / b.height * H, best = -1, bd = 1e9;
      rows.forEach(function (r, i) { var dx = px(xs[i]) - x, dy = py(ys[i]) - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } });
      return bd <= 14 * 14 * (W / b.width) * (W / b.width) ? best : -1;
    };
    var hot = -1;
    svg.addEventListener("mousemove", function (e) {
      var i = nearest(e);
      if (hot >= 0 && circles[hot]) circles[hot].classList.remove("hot");
      hot = i;
      if (i < 0) { tip.hidden = true; svg.style.cursor = ""; return; }
      circles[i].classList.add("hot"); svg.style.cursor = "pointer";
      var r = rows[i];
      tip.innerHTML = "<b>" + esc(r.name) + "</b><span>" + esc(r.county) + " County</span><span>" + esc(mx[1]) + ": " + esc(mx[2](xs[i])) + "</span><span>" + esc(my[1]) + ": " + esc(my[2](ys[i])) + "</span>";
      tip.hidden = false;
      var wr = el.getBoundingClientRect(), cr = circles[i].getBoundingClientRect();
      var left = cr.left - wr.left + 12, top = cr.top - wr.top - tip.offsetHeight - 6;
      if (left + tip.offsetWidth > wr.width) left = cr.left - wr.left - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + "px"; tip.style.top = Math.max(0, top) + "px";
    });
    svg.addEventListener("mouseleave", function () { tip.hidden = true; if (hot >= 0 && circles[hot]) circles[hot].classList.remove("hot"); hot = -1; });
    svg.addEventListener("click", function (e) { var i = nearest(e); if (i >= 0) openProfile(rows[i].geoid, false); });
  }
  function downloadChart() {
    var rows = chartRows(), q = function (v) { if (!has(v)) return ""; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var head = ["geoid", "name", "county", "housing_region", S.cx, S.cy];
    var lines = [head.join(",")].concat(rows.map(function (r) { return head.map(function (c) { return q(r[c]); }).join(","); }));
    if (S.adv) lines.push("# custom assumptions: " + advLabel(S.adv));
    download("openhousing_" + S.cx + "_vs_" + S.cy + ".csv", lines.join("\n") + "\n");
  }

  // ------------------------------------------------------------------ regions view
  var RCOLS = [
    { k: "name", l: "Area", f: null, cls: "l" },
    { k: "counties", l: "Counties", f: null, cls: "l", only: "housing_region" },
    { k: "towns", l: "Towns", f: function (v) { return num(v); } },
    { k: "households", l: "Households", f: function (v) { return num(v); } },
    { k: "ownership_burden_hh_weighted", l: "Owning ÷ county income", f: function (v) { return pct(v); }, tip: "Average of town ownership burdens, weighted by households." },
    { k: "rent_burden_renter_weighted", l: "Rent ÷ county income", f: function (v) { return pct(v); }, tip: "Average of town rent burdens, weighted by renter households." },
    { k: "price_to_income_hh_weighted", l: "Home value ÷ town income", f: ratio, tip: "Average of town price-to-income ratios, weighted by households." },
    { k: "median_town_home_value", l: "Typical home value (median town)", f: money },
    { k: "median_town_rent", l: "Median rent (median town)", f: rentMoney },
    { k: "share_hh_where_owning_unaffordable_ami80", l: "Households where owning is out of reach*", f: function (v) { return pct(v); }, tip: "Share of households living in towns where owning the typical home would cost a moderate-income family of four (HUD 80% limit) more than 30% of its income." },
    { k: "share_renters_where_rent_unaffordable_ami80", l: "Renters where rent is out of reach*", f: function (v) { return pct(v); }, tip: "Share of renter households living in towns where the median rent would cost a moderate-income family of four more than 30% of its income." },
    { k: "present_need_total", l: "Present need", f: function (v) { return num(v); } },
    { k: "prospective_need_total", l: "Prospective need", f: function (v) { return num(v); } },
    { k: "total_need_per_1000_hh", l: "Need per 1,000 households", f: function (v) { return num(v, 1); } },
    { k: "urban_aid_towns", l: "Urban Aid towns", f: function (v) { return num(v); } }
  ];
  function regionRows() {
    var R = D.regions, idx = {}; R.columns.forEach(function (c, i) { idx[c] = i; });
    return R.data.map(function (a) { var o = {}; R.columns.forEach(function (c) { o[c] = a[idx[c]]; }); return o; });
  }
  function renderRegions() {
    var go = function () {
      var all = regionRows(), lv = S.rlevel;
      var list = all.filter(function (g) { return g.level === lv; }), state = all.filter(function (g) { return g.level === "state"; })[0];
      var cols = RCOLS.filter(function (c) { return !c.only || c.only === lv; });
      var key = S.rsort, dir = S.rasc ? 1 : -1;
      list.sort(function (a, b) {
        var va = a[key], vb = b[key];
        if (key === "name" && lv === "housing_region") { va = Number(a.id); vb = Number(b.id); }
        if (typeof va === "string" || typeof vb === "string") return dir * String(va).localeCompare(String(vb));
        if (!has(va)) return 1; if (!has(vb)) return -1; return dir * (va - vb);
      });
      var th = cols.map(function (c) {
        var sort = S.rsort === c.k ? (S.rasc ? "ascending" : "descending") : "none";
        return '<th scope="col" class="' + (c.cls || "") + '" aria-sort="' + sort + '"><button type="button" data-rsort="' + c.k + '"' + (c.tip ? ' data-tip="' + esc(c.tip) + '"' : "") + ">" + esc(c.l) + "</button></th>";
      }).join("");
      var cell = function (g, c, i) {
        var v = g[c.k], t = c.f ? c.f(v) : (has(v) ? v : UNAV);
        if (i === 0) return '<th scope="row" class="l">' + (g.level === "county" ? '<button type="button" class="linkbtn" data-rcounty="' + esc(g.counties) + '">' + esc(t) + "</button>" : esc(t)) + "</th>";
        return '<td class="' + (c.cls || "") + (t === UNAV ? " muted" : "") + '">' + esc(t) + "</td>";
      };
      $("rtable").innerHTML = '<caption class="sr">Summaries by ' + (lv === "county" ? "county" : "housing region") + "</caption><thead><tr>" + th + "</tr></thead><tbody>" +
        list.map(function (g) { return "<tr>" + cols.map(function (c, i) { return cell(g, c, i); }).join("") + "</tr>"; }).join("") + "</tbody>" +
        (state ? '<tfoot><tr class="tot">' + cols.map(function (c, i) { return c.k === "counties" ? "<td></td>" : cell(state, c, i); }).join("") + "</tr></tfoot>" : "");
      document.querySelectorAll("[data-rlevel]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.rlevel === lv)); });
    };
    if (D.regions) return go();
    getJSON(PATHS.regions).then(function (g) { D.regions = g; go(); })
      .catch(function () { $("rtable").innerHTML = '<caption>Summaries couldn’t be loaded.</caption>'; });
  }

  // ------------------------------------------------------------------ views & hash
  function setView(v) {
    S.view = v;
    VIEWS.forEach(function (k) {
      $(k + "-view").hidden = k !== v;
      document.querySelector('.tab[data-view="' + k + '"]').setAttribute("aria-pressed", String(k === v));
    });
    if (v === "table") renderTable();
    if (v === "compare") renderCompare();
    if (v === "chart") renderChart();
    if (v === "regions") renderRegions();
    if (v === "map" && map) setTimeout(function () { map.resize(); }, 0);
    writeHash();
  }
  function writeHash() {
    var parts = [];
    if (S.view !== "map") parts.push("view=" + S.view);
    if (S.layer !== "ownership_score") parts.push("layer=" + S.layer);
    if (S.selected) parts.push("town=" + S.selected);
    if (S.adv) parts.push("a=" + advToHash());
    if (S.view === "chart") { parts.push("x=" + S.cx, "y=" + S.cy); if (S.ccounty) parts.push("county=" + encodeURIComponent(S.ccounty)); if (S.cregion) parts.push("region=" + S.cregion); if (S.clog) parts.push("log=1"); }
    if (S.view === "regions" && S.rlevel !== "county") parts.push("level=" + S.rlevel);
    var h = parts.length ? "#" + parts.join("&") : "";
    if (location.hash !== h) history.replaceState(null, "", h || location.pathname + location.search);
  }
  function readHash() {
    var p = {}; location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var a = kv.split("="); if (a[0]) p[a[0]] = decodeURIComponent(a[1] || ""); });
    if (p.layer && LAYER_BY_KEY[p.layer]) { S.layer = p.layer; updateLayerButton(); }
    if (p.view && VIEWS.indexOf(p.view) >= 0) S.view = p.view;
    if (p.town && D.byId[p.town]) S.selected = p.town;
    if (p.x && MBY[p.x]) S.cx = p.x;
    if (p.y && MBY[p.y]) S.cy = p.y;
    if (p.county) S.ccounty = p.county;
    if (p.region) S.cregion = p.region;
    S.clog = p.log === "1";
    if (p.level === "housing_region") S.rlevel = "housing_region";
    if (p.a) { var a = advFromHash(p.a); if (a) S.pendingAdv = a; }
  }
  function renderAll() {
    fillChartControls();
    fillAdvForm(advDefaults());
    if (S.pendingAdv) { var a = S.pendingAdv; S.pendingAdv = null; applyAssumptions(a); }
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
    wirePopover("adv-btn", "adv-pop");
    wireAdvanced();
    $("d-body").addEventListener("click", function (e) {
      if (e.target.closest("#hist-btn")) { toggleTownHistory(); return; }
      var t = e.target.closest("[data-trend]");
      if (t) { S.trendMode = t.dataset.trend; document.querySelectorAll("[data-trend]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === t)); });
               var r = D.byId[S.selected]; if (r) fillTrend(r); }
    });
    var chartCtrls = ["cx", "cy", "ccounty", "cregion"];
    chartCtrls.forEach(function (id) {
      $(id).addEventListener("change", function () { S[id] = $(id).value; renderChart(); writeHash(); });
    });
    $("clog").addEventListener("change", function () { S.clog = $("clog").checked; renderChart(); writeHash(); });
    $("cswap").addEventListener("click", function () { var t = S.cx; S.cx = S.cy; S.cy = t; $("cx").value = S.cx; $("cy").value = S.cy; renderChart(); writeHash(); });
    $("dl-chart").addEventListener("click", downloadChart);
    document.querySelectorAll("[data-rlevel]").forEach(function (b) {
      b.addEventListener("click", function () { S.rlevel = b.dataset.rlevel; S.rsort = "name"; S.rasc = true; renderRegions(); writeHash(); });
    });
    $("rtable").addEventListener("click", function (e) {
      var s2 = e.target.closest("button[data-rsort]");
      if (s2) { var k = s2.dataset.rsort; if (S.rsort === k) S.rasc = !S.rasc; else { S.rsort = k; S.rasc = k === "name" || k === "counties"; } renderRegions(); return; }
      var c = e.target.closest("button[data-rcounty]");
      if (c) { S.tquery = c.dataset.rcounty; $("tsearch").value = S.tquery; setView("table"); }
    });
    var rz = null;
    window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(function () { if (S.view === "chart") renderChart(); }, 150); });
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
      if (D.rows.length) { renderList(); renderLegend(); renderSnapshot(); fillLayerSelect(); if (S.view === "chart") renderChart(); if (S.selected) openProfile(S.selected, false); }
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
