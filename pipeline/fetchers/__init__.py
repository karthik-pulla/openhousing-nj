"""One module per data source. Each exposes `fetch() -> FetchResult`.

Order matters only where noted: zillow rebuilds its crosswalk from the file
it downloads, so it runs after geography.
"""
from . import acs, acs_history, acs_trend, fourth_round, fred, hud, nzlud, property_tax, zillow

FETCHERS = {
    "acs": acs.fetch,
    "acs_history": acs_history.fetch,
    "acs_trend": acs_trend.fetch,
    "zillow": zillow.fetch,
    "property_tax": property_tax.fetch,
    "hud": hud.fetch,
    "fred": fred.fetch,
    "nzlud": nzlud.fetch,
    "fourth_round": fourth_round.fetch,
}
