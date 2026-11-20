/* Shared script for the text pages (landing, methodology, sources):
   theme toggle, last-updated date and required notices from the data manifest,
   and the source list on the sources page. */
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
  });

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
})();
