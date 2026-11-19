/* OpenHousing NJ v2 front end. Plain JavaScript, no build step.
 *
 * Reads only published, validated files:
 *   ../data/published/openhousing_nj.web.json   one row per municipality (same columns as the CSV)
 *   ../data/published/summaries.web.json        template summaries (loaded when a profile opens)
 *   ../data/manifest.json                       sources, vintages, publish date
 *   data/boundaries.geojson                     simplified NJOGIS boundaries, joined on geoid
 * No accounts, no tracking. localStorage holds only the theme, favorites and comparison list.
 */
(function () {
  "use strict";

  var MAPBOX_TOKEN = "pk.eyJ1Ijoia2FydGhpa3B1bGxhIiwiYSI6ImNtcm54aTBpODA0MTIyenB6c3ZocmtvZDUifQ.lj2b4gjgCavNcMso7fcI6g";
  var PATHS = {
    data: "../data/published/openhousing_nj.web.json",
    summaries: "../data/published/summaries.web.json",
    manifest: "../data/manifest.json",
    bounds: "data/boundaries.geojson",
    csv: "../data/published/openhousing_nj.csv"
  };
  var NJ_BOUNDS = [[-75.6, 38.92], [-73.88, 41.36]];
  var MAX_COMPARE = 3;
  var UNAV = "Unavailable";

  // One-hue sequential ramps (light -> dark), equal lightness steps across hues.
  // Blue = affordability scores (darker = more affordable); orange = cost shares
  // (darker = costs take more of income); violet = barriers. In dark mode the
  // ramp flips so low values sit near the dark map surface.
  var RAMPS = {
    blue:   ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0d366b"],
    orange: ["#f7c3b0", "#ef9a7b", "#e36f42", "#c94908", "#9e3703", "#752601", "#611e01"],
    violet: ["#cacbfb", "#a9a9f7", "#8a85f2", "#6f62e1", "#5549b4", "#3e3388", "#322a71"]
  };

  // ------------------------------------------------------------------ formatting
  function has(v) { return v !== null && v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v)); }
  function money(v) { if (!has(v)) return UNAV; var s = v >= 100000 ? 1000 : v >= 1000 ? 100 : 10; return "$" + (Math.round(v / s) * s).toLocaleString("en-US"); }
  function rentMoney(v) { return has(v) ? "$" + (Math.round(v / 10) * 10).toLocaleString("en-US") : UNAV; }  // rents: nearest $10
  function pct(v, d) { return has(v) ? (v * 100).toFixed(d || 0) + "%" : UNAV; }
  function num(v, d) { return has(v) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }) : UNAV; }
  function ordinal(n) { n = Math.round(n); var s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"; return n.toLocaleString("en-US") + s; }
  function yesno(v) { return has(v) ? (v === true || v === "True" ? "Yes" : "No") : UNAV; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function isTrue(v) { return v === true || v === "True"; }

  // ------------------------------------------------------------------ layers
  var LAYERS = [
    { group: "Affordability scores", key: "ownership_score", label: "Ownership affordability score", ramp: "blue",
      fmt: function (v) { return num(v, 1); }, better: "high", best: "Most affordable", worst: "Least affordable",
      rank: "ownership_rank", conf: "ownership_confidence",
      desc: "0-100 percentile. Higher = owning the typical home costs a smaller share of county income. Mortgage plus average property tax.",
      ends: ["Less affordable", "More affordable"] },
    { group: "Affordability scores", key: "rental_score", label: "Rental affordability score", ramp: "blue",
      fmt: function (v) { return num(v, 1); }, better: "high", best: "Most affordable", worst: "Least affordable",
      rank: "rental_rank", conf: "rental_confidence",
      desc: "0-100 percentile. Higher = the median rent is a smaller share of county income.",
      ends: ["Less affordable", "More affordable"] },
    { group: "Cost measures", key: "ownership_burden", label: "Cost of owning ÷ county income", ramp: "orange",
      fmt: function (v) { return pct(v); }, better: "low", best: "Lowest share", worst: "Highest share",
      desc: "Yearly mortgage payment on the typical home plus the average property tax bill, as a share of county median household income.",
      ends: ["Smaller share", "Larger share"] },
    { group: "Cost measures", key: "rent_burden", label: "Rent ÷ county income", ramp: "orange",
      fmt: function (v) { return pct(v); }, better: "low", best: "Lowest share", worst: "Highest share",
      desc: "Twelve months of median gross rent as a share of county median household income.",
      ends: ["Smaller share", "Larger share"] },
    { group: "Cost measures", key: "ownership_burden_ami80", label: "Cost of owning ÷ HUD 80% income limit", ramp: "orange",
      fmt: function (v) { return pct(v); }, better: "low", best: "Lowest share", worst: "Highest share",
      desc: "Ownership cost as a share of HUD's low-income limit (80% of area median income) for a four-person household. 30% or less is considered affordable.",
      ends: ["Smaller share", "Larger share"] },
    { group: "Cost measures", key: "renters_cost_burdened_share", label: "Renters paying 30%+ of income (context)", ramp: "orange",
      fmt: function (v) { return pct(v); }, better: "low", best: "Lowest share", worst: "Highest share",
      desc: "Share of renter households paying 30% or more of their own income on rent. Context only: not part of either score. Unreliable in small towns.",
      ends: ["Smaller share", "Larger share"] },
    { group: "Barriers (not in the scores)", key: "zri", label: "Zoning restrictiveness (NZLUD)", ramp: "violet",
      fmt: function (v) { return num(v, 2); }, better: null, best: "Most restrictive", worst: "Least restrictive",
      desc: "National Zoning and Land Use Database restrictiveness index (higher = more restrictive). Covers 105 of 564 towns; gray = not covered.",
      ends: ["Less restrictive", "More restrictive"] },
    { group: "Barriers (not in the scores)", key: "prospective_need_per_1000_hh", label: "Prospective need per 1,000 households", ramp: "violet",
      fmt: function (v) { return num(v, 1); }, better: null, best: "Highest", worst: "Lowest",
      desc: "Fourth Round (2025-2035) prospective need as calculated by the state in October 2024, per 1,000 households. Qualified Urban Aid towns have none by law; their 0 is not missing data.",
      ends: ["Lower", "Higher"] },
    { group: "Barriers (not in the scores)", key: "present_need", label: "Present need (units)", ramp: "violet",
      fmt: function (v) { return num(v); }, better: null, best: "Highest", worst: "Lowest",
      desc: "Fourth Round present need (deficient housing occupied by low- and moderate-income households) as calculated by the state in October 2024.",
      ends: ["Lower", "Higher"] },
    { group: "Barriers (not in the scores)", key: "qualified_urban_aid", label: "Qualified Urban Aid municipality", ramp: "violet",
      categorical: true, fmt: yesno, better: null, best: "Yes first", worst: "No first",
      desc: "Qualified Urban Aid municipalities (47) have no prospective need obligation under the Affordable Housing Law. They may still have a present need.",
      ends: ["No", "Yes"] }
  ];
  var LAYER_BY_KEY = {};
  LAYERS.forEach(function (l) { LAYER_BY_KEY[l.key] = l; });

  // Profile metric rows: [column, label, formatter, source key, percentile column, confidence column]
  var SECTIONS = [
    { title: "Owning", rows: [
      ["home_value", "Typical home value", money, "home_value"],
      ["annual_mortgage_pi", "Yearly mortgage payment (principal & interest)", money, "fred"],
      ["avg_property_tax_bill", "Average residential property tax bill", money, "property_tax_municipal"],
      ["annual_ownership_cost", "Yearly ownership cost", money, "derived"],
      ["county_median_hh_income", "County median household income", money, "acs_county"],
      ["ownership_burden", "Ownership cost ÷ county income", pct, "derived", "ownership_burden_pctl", "ownership_burden_confidence"],
      ["ownership_burden_town_income", "Ownership cost ÷ town income (display only)", pct, "derived"]
    ]},
    { title: "Renting", rows: [
      ["median_gross_rent", "Median gross rent (monthly)", rentMoney, "acs_municipal"],
      ["rent_burden", "Yearly rent ÷ county income", pct, "derived", "rent_burden_pctl", "rent_burden_confidence"],
      ["rent_burden_town_income", "Yearly rent ÷ town income (display only)", pct, "derived"],
      ["renters_cost_burdened_share", "Renters paying 30%+ of income (context)", pct, "acs_municipal", null, "renters_cost_burdened_confidence"],
      ["fmr_2br", "HUD Fair Market Rent, 2 bedrooms", rentMoney, "hud_county"]
    ]},
    { title: "Moderate-income household (HUD 80% limit, 4 people)", rows: [
      ["ami80_income_limit", "Income limit", money, "hud_county"],
      ["ownership_burden_ami80", "Ownership cost ÷ income limit", pct, "derived"],
      ["ownership_affordable_at_ami80", "Ownership affordable (30% or less)?", yesno, "derived"],
      ["rent_burden_ami80", "Yearly rent ÷ income limit", pct, "derived"],
      ["rent_affordable_at_ami80", "Rent affordable (30% or less)?", yesno, "derived"]
    ]},
    { title: "Barriers (not part of the scores)", rows: [
      ["zri", "Zoning restrictiveness index (NZLUD)", function (v) { return num(v, 2); }, "nzlud_municipal"],
      ["present_need", "Fourth Round present need (units)", function (v) { return num(v); }, "fourth_round_municipal"],
      ["prospective_need_capped", "Fourth Round prospective need (units)", function (v) { return num(v); }, "fourth_round_municipal"],
      ["prospective_need_per_1000_hh", "Prospective need per 1,000 households", function (v) { return num(v, 1); }, "derived"],
      ["qualified_urban_aid", "Qualified Urban Aid municipality", yesno, "fourth_round_municipal"],
      ["households", "Households", function (v) { return num(v); }, "acs_municipal"]
    ]}
  ];

  // ------------------------------------------------------------------ state
  var D = { rows: [], byId: {}, cols: [], manifest: null, summaries: null, sources: {} };
  var S = { layer: "ownership_score", bestFirst: true, query: "", favOnly: false, selected: null,
            view: "map", compare: [], sortCol: "ownership_rank", sortAsc: true, tquery: "" };
  var map = null, mapReady = false, bounds = null, hoverId = null;
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
  function ramp(name) { var r = RAMPS[name].slice(); return isDark() ? r.reverse() : r; }
  function nodata() { return getComputedStyle(document.documentElement).getPropertyValue("--nodata").trim(); }

  // ------------------------------------------------------------------ classes (quantiles)
  function classesFor(layer) {
    if (classCache[layer.key]) return classCache[layer.key];
    var vals = D.rows.map(function (r) { return r[layer.key]; }).filter(has).map(Number).sort(function (a, b) { return a - b; });
    var k = 7, breaks = [];
    for (var i = 1; i < k; i++) breaks.push(vals[Math.min(vals.length - 1, Math.floor(i * vals.length / k))]);
    var mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    var out = { breaks: breaks, min: vals[0], max: vals[vals.length - 1], median: mid, n: vals.length };
    classCache[layer.key] = out;
    return out;
  }
  function colorFor(layer, v) {
    if (!has(v)) return null;
    var r = ramp(layer.ramp);
    if (layer.categorical) return isTrue(v) ? r[5] : r[1];   // r is already flipped for dark mode
    var c = classesFor(layer), i = 0;
    while (i < c.breaks.length && Number(v) >= c.breaks[i]) i++;
    return r[i];
  }

  // ------------------------------------------------------------------ loading
  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }

  function init() {
    wireUI();
    Promise.all([getJSON(PATHS.data), getJSON(PATHS.manifest)]).then(function (res) {
      var split = res[0];
      D.cols = split.columns;
      D.rows = split.data.map(function (a) { var o = {}; for (var i = 0; i < D.cols.length; i++) o[D.cols[i]] = a[i]; return o; });
      D.rows.forEach(function (r) { r.geoid = String(r.geoid); D.byId[r.geoid] = r; });
      D.manifest = res[1];
      (D.manifest.sources || []).forEach(function (s) { D.sources[s.name] = s; });
      setStatus("");
      renderMeta();
      fillLayerSelect();
      readHash();
      renderAll();
      initMap();
    }).catch(function (e) {
      setStatus("Couldn't load the data (" + e.message + "). If you opened this file directly, serve the repository folder over HTTP.", true);
    });
  }

  function renderMeta() {
    var m = D.manifest, d = new Date(m.published_at);
    var when = isNaN(d) ? m.published_at : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    var line = "Data last updated " + when + ". " + D.rows.length + " municipalities.";
    $("updated").textContent = line;
    $("updated-pop").textContent = line + (m.zillow_included ? "" : " Home values currently come from the Census Bureau (ACS).");
    var list = $("source-list");
    list.innerHTML = "";
    var labels = { acs_municipal: "Census ACS (municipalities)", acs_county: "Census ACS (counties)",
      property_tax_municipal: "NJ property tax", hud_county: "HUD income limits & rents", fred_mortgage30: "Mortgage rate",
      nzlud_municipal: "Zoning (NZLUD)", fourth_round_municipal: "Fourth Round obligations", zillow_municipal: "Zillow home values" };
    m.sources.forEach(function (s) {
      var li = document.createElement("li");
      li.innerHTML = "<b>" + esc(labels[s.name] || s.name) + "</b><span>" + esc(s.vintage) + "</span>";
      list.appendChild(li);
    });
    var notices = m.sources.map(function (s) { return s.attribution; })
      .filter(function (a) { return /not endorsed/.test(a || ""); })
      .map(function (a) { var i = a.indexOf("This product uses"); return i >= 0 ? a.slice(i) : a; });
    $("notices").textContent = notices.join(" ");
  }

  function fillLayerSelect() {
    var sel = $("layer"), groups = {};
    LAYERS.forEach(function (l) {
      if (!groups[l.group]) { groups[l.group] = document.createElement("optgroup"); groups[l.group].label = l.group; sel.appendChild(groups[l.group]); }
      var o = document.createElement("option"); o.value = l.key; o.textContent = l.label; groups[l.group].appendChild(o);
    });
    sel.value = S.layer;
  }

  // ------------------------------------------------------------------ list (map view)
  function sortedForLayer() {
    var L = LAYER_BY_KEY[S.layer];
    var q = S.query.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (S.favOnly && favorites.indexOf(r.geoid) < 0) return false;
      return !q || (r.name + " " + r.county).toLowerCase().indexOf(q) >= 0;
    });
    var dir = (L.better === "low") ? 1 : -1;   // "best first" ordering
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
    $("layer-desc").textContent = L.desc;
    $("sort-best").textContent = L.best;
    $("sort-worst").textContent = L.worst;
    $("sort-best").setAttribute("aria-pressed", String(S.bestFirst));
    $("sort-worst").setAttribute("aria-pressed", String(!S.bestFirst));
    var rows = sortedForLayer();
    var withVal = rows.filter(function (r) { return has(r[L.key]); }).length;
    $("listcount").textContent = rows.length + " shown" + (withVal < rows.length ? " (" + (rows.length - withVal) + " without data listed last)" : "");
    var ol = $("list"), frag = document.createDocumentFragment();
    ol.innerHTML = "";
    rows.forEach(function (r, i) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.dataset.geoid = r.geoid;
      if (S.selected === r.geoid) b.setAttribute("aria-current", "true");
      var rankTxt = L.rank && has(r[L.rank]) ? "#" + r[L.rank] : (i + 1);
      var c = colorFor(L, r[L.key]);
      var star = favorites.indexOf(r.geoid) >= 0 ? " ★" : "";
      b.innerHTML = '<span class="n">' + rankTxt + '</span><span class="nm">' + esc(r.name) + star +
        '<span class="ct">' + esc(r.county) + ' County</span></span><span class="v">' +
        (c ? '<i class="sw" style="background:' + c + '" aria-hidden="true"></i>' : "") + esc(L.fmt(r[L.key])) + "</span>";
      b.setAttribute("aria-label", r.name + ", " + r.county + " County: " + L.label + " " + L.fmt(r[L.key]));
      li.appendChild(b);
      frag.appendChild(li);
    });
    ol.appendChild(frag);
  }

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    var L = LAYER_BY_KEY[S.layer], el = $("legend"), r = ramp(L.ramp);
    var html = "<h3>" + esc(L.label) + "</h3>";
    if (L.categorical) {
      html += '<div class="cats"><div><i style="background:' + colorFor(L, true) + '"></i>Yes</div>' +
              '<div><i style="background:' + colorFor(L, false) + '"></i>No</div></div>';
    } else {
      var c = classesFor(L);
      // r[i] is exactly the color used for class i (low -> high), already flipped for dark mode.
      html += '<div class="ramp" aria-hidden="true">' + r.map(function (col) {
        return '<span style="background:' + col + '"></span>'; }).join("") + "</div>";
      html += '<div class="ticks"><span>' + esc(L.fmt(c.min)) + "</span><span>" + esc(L.fmt(c.median)) + " (median)</span><span>" + esc(L.fmt(c.max)) + "</span></div>";
      html += '<div class="ends"><span>' + esc(L.ends[0]) + "</span><span>" + esc(L.ends[1]) + "</span></div>";
      html += '<p class="note">Seven groups with equal numbers of towns.</p>';
    }
    var missing = D.rows.filter(function (x) { return !has(x[L.key]); }).length;
    if (missing) html += '<div class="nd"><i aria-hidden="true"></i>No data (' + missing + " town" + (missing > 1 ? "s" : "") + ")</div>";
    el.innerHTML = html;
  }

  // ------------------------------------------------------------------ map
  function initMap() {
    if (!window.mapboxgl) { mapFailed("The map library didn't load."); return; }
    mapboxgl.accessToken = MAPBOX_TOKEN;
    try {
      map = new mapboxgl.Map({ container: "map", style: styleUrl(), bounds: NJ_BOUNDS, fitBoundsOptions: { padding: 20 },
                               attributionControl: true, cooperativeGestures: false });
    } catch (e) { mapFailed(e.message); return; }
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("error", function (e) {
      var msg = e && e.error && e.error.message || "";
      if (/401|403|token|Unauthorized|Forbidden/i.test(msg)) mapFailed("Map tiles were refused (" + msg + ").");
    });
    // Track style readiness ourselves: map.isStyleLoaded() stays false while
    // base tiles are still loading, which could skip adding our layers.
    var styleOk = false;
    map.on("style.load", function () { styleOk = true; addLayers(); });
    getJSON(PATHS.bounds).then(function (gj) { bounds = gj; if (styleOk) addLayers(); })
      .catch(function (e) { mapFailed("Boundaries didn't load (" + e.message + ")."); });
    wireMapEvents();
  }
  function styleUrl() { return isDark() ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11"; }
  function mapFailed(msg) {
    var el = $("map-error");
    el.hidden = false;
    el.textContent = msg + " Everything else works: use the list or the Table view.";
  }

  function paintedData() {
    var L = LAYER_BY_KEY[S.layer];
    bounds.features.forEach(function (f) {
      var r = D.byId[f.properties.geoid];
      f.properties.color = r ? colorFor(L, r[L.key]) : null;
      f.properties.name = r ? r.name : "";
    });
    return bounds;
  }

  function addLayers() {
    if (!bounds) return;
    if (map.getSource("munis")) { mapReady = true; repaint(); return; }
    var firstLabel = (map.getStyle().layers.find(function (l) { return l.type === "symbol"; }) || {}).id;
    map.addSource("munis", { type: "geojson", data: paintedData(), promoteId: "geoid" });
    map.addLayer({ id: "muni-fill", type: "fill", source: "munis",
      paint: { "fill-color": ["coalesce", ["get", "color"], nodata()], "fill-opacity": 0.88 } }, firstLabel);
    map.addLayer({ id: "muni-line", type: "line", source: "munis",
      paint: { "line-color": isDark() ? "#0b0e14" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.3, 11, 1.2] } }, firstLabel);
    map.addLayer({ id: "muni-hover", type: "line", source: "munis",
      paint: { "line-color": isDark() ? "#ffffff" : "#0b0f19", "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 1.6, 0] } });
    map.addLayer({ id: "muni-sel", type: "line", source: "munis", filter: ["==", ["get", "geoid"], S.selected || ""],
      paint: { "line-color": "#3F6AFF", "line-width": 3 } });
    mapReady = true;
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
      tip.innerHTML = "<b>" + esc(r.name) + "</b>" + esc(r.county) + " County<br>" + esc(L.label) + ": <b style='display:inline'>" + esc(L.fmt(r[L.key])) + "</b>";
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
    map.on("click", "muni-fill", function (e) { var f = e.features && e.features[0]; if (f) openProfile(f.properties.geoid, false); });
  }

  function zoomTo(geoid) {
    if (!mapReady || !bounds) return;
    var f = bounds.features.find(function (x) { return x.properties.geoid === geoid; }); if (!f) return;
    var b = new mapboxgl.LngLatBounds();
    (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).forEach(function (poly) {
      poly[0].forEach(function (c) { b.extend(c); });
    });
    var drawerOpen = !$("drawer").hidden && window.innerWidth > 860;
    map.fitBounds(b, { padding: { top: 40, bottom: 40, left: 40, right: drawerOpen ? 480 : 40 }, maxZoom: 12.5, duration: 600 });
  }

  // ------------------------------------------------------------------ profile
  function srcLine(key, r) {
    if (key === "derived") return "Calculated by OpenHousing from the rows above";
    if (key === "home_value") return has(r.home_value_source) ? r.home_value_source + ", " + (r.home_value_vintage || "") : "";
    if (key === "fred") { var f = D.sources.fred_mortgage30; return f ? "Rate " + num(r.mortgage_rate_pct, 2) + "%: " + f.vintage : ""; }
    var s = D.sources[key]; return s ? s.vintage : "";
  }
  function badge(level) {
    if (!has(level)) return "";
    var cls = level === "insufficient data" ? "none" : level;
    var txt = level === "insufficient data" ? "Insufficient data" : level.charAt(0).toUpperCase() + level.slice(1) + " confidence";
    return '<span class="badge ' + cls + '">' + esc(txt) + "</span>";
  }

  function openProfile(geoid, zoom) {
    var r = D.byId[geoid]; if (!r) return;
    S.selected = geoid;
    var dr = $("drawer");
    dr.hidden = false;
    $("p-name").textContent = r.name;
    $("p-sub").textContent = r.county + " County · " + r.mun_type + " · population " + num(r.population);
    updateProfileButtons();
    var nOwn = D.rows.filter(function (x) { return has(x.ownership_score); }).length;
    var nRent = D.rows.filter(function (x) { return has(x.rental_score); }).length;
    var html = '<div class="scorecards">' +
      card("Ownership score", r.ownership_score, r.ownership_rank, nOwn, r.ownership_confidence) +
      card("Rental score", r.rental_score, r.rental_rank, nRent, r.rental_confidence) + "</div>";
    html += '<p class="summary" id="p-summary">' + (D.summaries ? "" : "Loading summary…") + "</p>";
    html += '<div id="p-summary-src"></div>';
    var reasons = [];
    if (r.ownership_confidence_reasons) reasons.push("Ownership: " + r.ownership_confidence_reasons);
    if (r.rental_confidence_reasons) reasons.push("Rental: " + r.rental_confidence_reasons);
    if (reasons.length) html += '<p class="reasons"><b>About these estimates.</b> ' + esc(reasons.join(". ")) + ".</p>";
    SECTIONS.forEach(function (sec) {
      html += "<h3>" + esc(sec.title) + '</h3><table class="metrics"><tbody>';
      sec.rows.forEach(function (row) {
        var col = row[0], v = r[col], extra = "";
        if (row[4] && has(r[row[4]])) extra += '<span class="pc">' + ordinal(r[row[4]]) + " percentile (higher = more affordable)</span>";
        var conf = row[5] ? " " + badge(r[row[5]]) : "";
        var src = srcLine(row[3], r);
        html += "<tr><th scope='row'>" + esc(row[1]) + (src ? '<span class="src">' + esc(src) + "</span>" : "") + "</th><td>" +
          esc(row[2](v)) + extra + (conf ? "<span class='pc'>" + conf + "</span>" : "") + "</td></tr>";
      });
      html += "</tbody></table>";
    });
    html += '<p class="note" style="margin-top:14px">Assumptions: ' + esc(assumptionText()) + ' <a href="methodology.html">How this is calculated</a>.</p>';
    $("d-body").innerHTML = html;
    $("d-body").scrollTop = 0;
    fillSummary(r);
    $("p-name").focus();
    if (zoom !== false) zoomTo(geoid);
    repaint();
    markListSelection();
    writeHash();
  }
  function card(title, score, rank, n, conf) {
    return '<div class="card"><div class="k">' + esc(title) + '</div><div class="big">' + (has(score) ? num(score, 1) : "–") +
      '</div><div class="sub">' + (has(rank) ? "Ranks " + ordinal(rank) + " of " + n : "Not scored") + "</div>" + badge(conf) + "</div>";
  }
  function assumptionText() {
    var a = (D.manifest && D.manifest.assumptions) || {};
    return a.down_payment_pct + "% down payment, " + a.loan_term_years + "-year fixed mortgage at " + num(a.mortgage_rate_pct, 2) +
      "% (" + (a.mortgage_rate_vintage || "") + "). Excludes " + (a.excluded_costs || []).join(", ") + ".";
  }
  function fillSummary(r) {
    var go = function () {
      var t = D.summaries.towns[r.geoid], el = $("p-summary");
      if (!el || S.selected !== r.geoid) return;
      el.textContent = t ? t.summary : "No summary available.";
      if (t) {
        var keys = [];
        t.sentences.forEach(function (s) { s[1].forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
        $("p-summary-src").innerHTML = '<p class="note" style="margin-top:6px">Every sentence above is filled in from the data below. Sources:</p><ul class="srcs">' +
          keys.map(function (k) { var s = D.summaries.sources[k]; return s ? "<li>" + esc(s.name) + " (" + esc(s.vintage) + ")</li>" : ""; }).join("") + "</ul>";
      }
    };
    if (D.summaries) return go();
    getJSON(PATHS.summaries).then(function (s) { D.summaries = s; go(); })
      .catch(function () { var el = $("p-summary"); if (el) el.textContent = "The summary couldn't be loaded."; });
  }
  function closeProfile() {
    var prev = S.selected;
    $("drawer").hidden = true;
    S.selected = null;
    repaint(); markListSelection(); writeHash();
    var b = document.querySelector('.list button[data-geoid="' + prev + '"]');
    if (b && S.view === "map") b.focus();
  }
  function markListSelection() {
    document.querySelectorAll(".list button").forEach(function (b) {
      if (b.dataset.geoid === S.selected) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
  }
  function updateProfileButtons() {
    var g = S.selected; if (!g) return;
    var fav = favorites.indexOf(g) >= 0, inCmp = S.compare.indexOf(g) >= 0;
    $("fav-btn").textContent = fav ? "★ Favorite" : "☆ Add to favorites";
    $("fav-btn").setAttribute("aria-pressed", String(fav));
    $("cmp-btn").textContent = inCmp ? "✓ In comparison" : "+ Compare";
    $("cmp-btn").disabled = !inCmp && S.compare.length >= MAX_COMPARE;
    $("cmp-btn").title = $("cmp-btn").disabled ? "You can compare up to " + MAX_COMPARE + " towns" : "";
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
    $("compare-count").textContent = S.compare.length;
    updateProfileButtons(); renderCompare();
  }
  function renderCompare() {
    $("compare-count").textContent = S.compare.length;
    var wrap = $("compare-wrap"), towns = S.compare.map(function (g) { return D.byId[g]; }).filter(Boolean);
    $("dl-compare").disabled = !towns.length;
    $("compare-hint").textContent = towns.length ? "Comparing " + towns.length + " of up to " + MAX_COMPARE + ". Missing values show as \"Unavailable\"."
      : "Add up to three municipalities from a town profile (select \"+ Compare\").";
    if (!towns.length) { wrap.innerHTML = ""; return; }
    var h = '<table class="dt cmp"><caption class="sr">Side-by-side comparison</caption><thead><tr><th scope="col">Measure</th>';
    towns.forEach(function (t) {
      h += '<th scope="col" class="l">' + esc(t.name) + '<br><span class="muted">' + esc(t.county) + ' County</span><br>' +
        '<button type="button" class="linkbtn" data-open="' + t.geoid + '">Profile</button> · ' +
        '<button type="button" class="linkbtn" data-remove="' + t.geoid + '">Remove</button></th>';
    });
    h += "</tr></thead><tbody>";
    var rows = [["ownership_score", "Ownership score", function (v) { return num(v, 1); }], ["ownership_rank", "Ownership rank", function (v) { return has(v) ? ordinal(v) : UNAV; }],
      ["ownership_confidence", "Ownership confidence", function (v) { return has(v) ? v : UNAV; }],
      ["rental_score", "Rental score", function (v) { return num(v, 1); }], ["rental_rank", "Rental rank", function (v) { return has(v) ? ordinal(v) : UNAV; }],
      ["rental_confidence", "Rental confidence", function (v) { return has(v) ? v : UNAV; }]];
    SECTIONS.forEach(function (sec) { sec.rows.forEach(function (r) { rows.push([r[0], r[1], r[2]]); }); });
    rows.forEach(function (row) {
      h += '<tr><th scope="row" class="l">' + esc(row[1]) + "</th>";
      towns.forEach(function (t) { h += '<td class="l">' + esc(row[2](t[row[0]])) + "</td>"; });
      h += "</tr>";
    });
    wrap.innerHTML = h + "</tbody></table>";
  }

  // ------------------------------------------------------------------ table view
  var TCOLS = [
    ["name", "Municipality", null, "l"], ["county", "County", null, "l"],
    ["ownership_rank", "Ownership rank", function (v) { return has(v) ? num(v) : UNAV; }],
    ["ownership_score", "Ownership score", function (v) { return num(v, 1); }],
    ["ownership_burden", "Owning ÷ county income", function (v) { return pct(v); }],
    ["ownership_confidence", "Ownership confidence", function (v) { return has(v) ? v : UNAV; }, "l"],
    ["rental_rank", "Rental rank", function (v) { return has(v) ? num(v) : UNAV; }],
    ["rental_score", "Rental score", function (v) { return num(v, 1); }],
    ["rent_burden", "Rent ÷ county income", function (v) { return pct(v); }],
    ["rental_confidence", "Rental confidence", function (v) { return has(v) ? v : UNAV; }, "l"],
    ["home_value", "Home value", money], ["median_gross_rent", "Median rent", rentMoney],
    ["renters_cost_burdened_share", "Renters 30%+ (context)", function (v) { return pct(v); }],
    ["prospective_need_capped", "Prospective need", function (v) { return num(v); }],
    ["prospective_need_per_1000_hh", "Per 1,000 households", function (v) { return num(v, 1); }],
    ["qualified_urban_aid", "Urban Aid", yesno, "l"], ["zri", "Zoning (NZLUD)", function (v) { return num(v, 2); }]
  ];
  function renderTableHead() {
    var tr = "<tr>" + TCOLS.map(function (c) {
      var sort = S.sortCol === c[0] ? (S.sortAsc ? "ascending" : "descending") : "none";
      return '<th scope="col" class="' + (c[3] || "") + '" aria-sort="' + sort + '"><button type="button" data-sort="' + c[0] + '">' + esc(c[1]) + "</button></th>";
    }).join("") + "</tr>";
    document.querySelector("#table thead").innerHTML = tr;
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
    var html = rows.map(function (r) {
      return "<tr>" + TCOLS.map(function (c, i) {
        var v = r[c[0]];
        if (i === 0) return '<th scope="row" class="l"><button type="button" class="linkbtn" data-open="' + r.geoid + '">' + esc(r.name) + "</button></th>";
        var txt = c[2] ? c[2](v) : (has(v) ? v : UNAV);
        return '<td class="' + (c[3] || "") + (txt === UNAV ? " muted" : "") + '">' + esc(txt) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    document.querySelector("#table tbody").innerHTML = html;
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
    var h = parts.length ? "#" + parts.join("&") : " ";
    if (location.hash !== h.trim()) history.replaceState(null, "", h === " " ? location.pathname + location.search : h);
  }
  function readHash() {
    var p = {}; location.hash.replace(/^#/, "").split("&").forEach(function (kv) { var a = kv.split("="); if (a[0]) p[a[0]] = decodeURIComponent(a[1] || ""); });
    if (p.layer && LAYER_BY_KEY[p.layer]) { S.layer = p.layer; $("layer").value = p.layer; }
    if (p.view && ["map", "table", "compare"].indexOf(p.view) >= 0) S.view = p.view;
    if (p.town && D.byId[p.town]) S.selected = p.town;
  }
  function renderAll() {
    renderList(); renderLegend(); renderCompare();
    setView(S.view);
    if (S.selected) openProfile(S.selected, false);
  }

  // ------------------------------------------------------------------ events
  function wireUI() {
    $("search").addEventListener("input", function (e) { S.query = e.target.value; renderList(); });
    $("layer").addEventListener("change", function (e) { S.layer = e.target.value; S.bestFirst = true; renderList(); renderLegend(); repaint(); writeHash(); });
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
    var pop = $("sources-pop"), pb = $("sources-btn");
    pb.addEventListener("click", function (e) { e.stopPropagation(); var open = !pop.classList.contains("open"); pop.classList.toggle("open", open); pb.setAttribute("aria-expanded", String(open)); });
    document.addEventListener("click", function (e) { if (!pop.contains(e.target) && e.target !== pb) { pop.classList.remove("open"); pb.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (pop.classList.contains("open")) { pop.classList.remove("open"); pb.setAttribute("aria-expanded", "false"); pb.focus(); }
      else if (!$("drawer").hidden) closeProfile();
    });
    $("theme-btn").addEventListener("click", function () {
      var t = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("oh-theme", t); } catch (e) {}
      if (D.rows.length) { renderList(); renderLegend(); }
      if (map) { mapReady = false; map.setStyle(styleUrl()); }   // style.load re-adds the layers
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
