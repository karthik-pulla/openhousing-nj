"""Data dictionary: one entry per published column.

Written at publish time to data/published/data_dictionary.csv and
data_dictionary.web.json (the Dictionary page reads the JSON). A test fails if
a published column has no entry here, so the dictionary can't fall behind.

Each entry: (group, label, unit, source, description).
Sources: ACS = U.S. Census Bureau American Community Survey 5-year (municipal
unless noted); DCA = NJ Department of Community Affairs; HUD = HUD USER API;
FRED = Freddie Mac PMMS via FRED; NZLUD = National Zoning and Land Use Database;
NJOGIS = NJ Office of GIS; OpenHousing = calculated by OpenHousing from the others.
"""
from __future__ import annotations

import json

import pandas as pd

from .common import PUBLISHED

G_ID, G_OWN, G_RENT, G_INC, G_MEAS, G_SCORE, G_REL, G_BAR, G_ZIL, G_META = (
    "Town", "Owning", "Renting", "Income", "Measures", "Scores and ranks", "Reliability", "Barriers (not scored)",
    "Zillow (empty until cleared)", "Record")

DICTIONARY: dict[str, tuple[str, str, str, str, str]] = {
    "geoid": (G_ID, "Census GEOID", "code", "Census / NJOGIS", "10-digit Census county subdivision code. The key every source is joined on."),
    "mun_code": (G_ID, "NJ municipal code", "code", "NJOGIS", "New Jersey's 4-digit municipal code (county + town)."),
    "name": (G_ID, "Municipality", "text", "Census / NJOGIS", "Municipality name with its type (Borough, Township, City, Town, Village)."),
    "mun_type": (G_ID, "Type", "text", "Census", "Form of municipality."),
    "county": (G_ID, "County", "text", "Census", "County name."),
    "county_fips": (G_ID, "County FIPS", "code", "Census", "5-digit county FIPS code."),
    "population": (G_ID, "Population", "people", "ACS", "Total population."),
    "households": (G_ID, "Households", "households", "ACS", "Occupied housing units."),
    "renter_households": (G_ID, "Renter households", "households", "ACS", "Renter-occupied housing units."),
    "town_median_hh_income": (G_INC, "Town median household income", "dollars/year", "ACS", "Median household income of the town's residents (B19013)."),
    "town_median_hh_income_moe": (G_INC, "Margin of error", "dollars", "ACS", "90% margin of error of town median household income."),
    "town_median_hh_income_topcoded": (G_INC, "Top-coded", "true/false", "ACS", "True if the Census reports only that the median is at least $250,000."),
    "acs_median_home_value": (G_OWN, "ACS median home value", "dollars", "ACS", "Median value of owner-occupied homes, as estimated by owners (B25077)."),
    "acs_median_home_value_moe": (G_OWN, "Margin of error", "dollars", "ACS", "90% margin of error of the ACS median home value."),
    "acs_median_home_value_topcoded": (G_OWN, "Top-coded", "true/false", "ACS", "True if the Census reports only that the median is at least $2,000,000."),
    "median_gross_rent": (G_RENT, "Median gross rent", "dollars/month", "ACS", "Median monthly rent plus utilities paid by renters (B25064)."),
    "median_gross_rent_moe": (G_RENT, "Margin of error", "dollars", "ACS", "90% margin of error of median gross rent."),
    "median_gross_rent_topcoded": (G_RENT, "Top-coded", "true/false", "ACS", "True if the Census reports only that the median is at least $3,500."),
    "renters_cost_burdened_share": (G_RENT, "Renters paying 30%+ of income", "share (0-1)", "ACS", "Share of renter households (with computed ratio) paying 30% or more of their own income on rent (B25070)."),
    "renters_cost_burdened_share_moe": (G_RENT, "Margin of error", "share", "ACS", "Approximate 90% margin of error of the cost-burdened share."),
    "county_median_hh_income": (G_INC, "County median household income", "dollars/year", "ACS (county)", "Median household income of the county. The income used in both scores."),
    "county_median_hh_income_moe": (G_INC, "Margin of error", "dollars", "ACS (county)", "90% margin of error of county median household income."),
    "avg_property_tax_bill": (G_OWN, "Average residential property tax bill", "dollars/year", "DCA", "Average total property tax on a residential property, before credits and deductions."),
    "tax_year": (G_OWN, "Tax year", "year", "DCA", "Tax year of the property tax data."),
    "dca_equalized_avg_res_value": (G_OWN, "State-assessed average residential value", "dollars", "DCA / OpenHousing", "DCA average residential assessment divided by the town's equalization ratio: an average market value from tax assessments, not a median. Used as the home value only where the Census has none."),
    "hud_area_name": (G_INC, "HUD area", "text", "HUD", "HUD Fair Market Rent / income limit area containing the town."),
    "ami80_income_limit": (G_INC, "HUD 80% income limit (4 people)", "dollars/year", "HUD", "HUD low-income limit (80% of area median income) for a four-person household."),
    "fmr_2br": (G_RENT, "HUD Fair Market Rent, 2 bedrooms", "dollars/month", "HUD", "Area-wide Fair Market Rent for a two-bedroom home."),
    "zhvi": (G_ZIL, "Zillow Home Value Index", "dollars", "Zillow", "Empty: Zillow is not published until its terms are confirmed."),
    "zhvi_month": (G_ZIL, "ZHVI month", "month", "Zillow", "Empty until Zillow is cleared."),
    "zillow_method": (G_ZIL, "Zillow matching method", "text", "OpenHousing", "Empty until Zillow is cleared."),
    "zillow_regions": (G_ZIL, "Zillow regions used", "text", "Zillow", "Empty until Zillow is cleared."),
    "zhvi_1yr_change": (G_ZIL, "ZHVI 1-year change", "share", "Zillow", "Empty until Zillow is cleared."),
    "zhvi_5yr_change": (G_ZIL, "ZHVI 5-year change", "share", "Zillow", "Empty until Zillow is cleared."),
    "home_value": (G_OWN, "Typical home value (used)", "dollars", "see home_value_source", "The home value used for owning costs: Zillow if cleared, else the ACS median, else the DCA equalized average."),
    "home_value_source": (G_OWN, "Home value source", "text", "OpenHousing", "Which source home_value came from."),
    "home_value_vintage": (G_OWN, "Home value data period", "text", "OpenHousing", "Data period of home_value."),
    "value_sources_disagree": (G_ZIL, "Zillow and ACS disagree", "true/false", "OpenHousing", "Empty until Zillow is cleared."),
    "mortgage_rate_pct": (G_OWN, "Mortgage rate used", "percent", "FRED", "30-year fixed rate: mean of the latest four weekly Freddie Mac PMMS readings."),
    "annual_mortgage_pi": (G_OWN, "Mortgage payment, per year", "dollars/year", "OpenHousing", "Principal and interest on home_value with 20% down, 30-year fixed at mortgage_rate_pct."),
    "annual_ownership_cost": (G_OWN, "Ownership cost, per year", "dollars/year", "OpenHousing", "annual_mortgage_pi + avg_property_tax_bill. Leaves out insurance, PMI, HOA fees, maintenance, utilities."),
    "annual_rent": (G_RENT, "Rent, per year", "dollars/year", "OpenHousing", "12 x median_gross_rent."),
    "ownership_burden": (G_MEAS, "Cost to own ÷ county income", "share", "OpenHousing", "annual_ownership_cost / county_median_hh_income. The measure behind the ownership score."),
    "rent_burden": (G_MEAS, "Rent ÷ county income", "share", "OpenHousing", "annual_rent / county_median_hh_income. The measure behind the rental score."),
    "renters_cost_burdened": (G_MEAS, "Renters paying 30%+ (measure copy)", "share", "ACS", "Same as renters_cost_burdened_share; context only, not scored."),
    "ownership_burden_town_income": (G_MEAS, "Cost to own ÷ town income", "share", "OpenHousing", "annual_ownership_cost / town_median_hh_income. Display only."),
    "rent_burden_town_income": (G_MEAS, "Rent ÷ town income", "share", "OpenHousing", "annual_rent / town_median_hh_income. Display only."),
    "ownership_burden_ami80": (G_MEAS, "Cost to own ÷ HUD 80% limit", "share", "OpenHousing", "annual_ownership_cost / ami80_income_limit."),
    "rent_burden_ami80": (G_MEAS, "Rent ÷ HUD 80% limit", "share", "OpenHousing", "annual_rent / ami80_income_limit."),
    "price_to_income": (G_MEAS, "Home value ÷ town income", "ratio", "OpenHousing", "home_value / town_median_hh_income: years of town income the typical home costs (v1's measure). Not scored."),
    "price_to_county_income": (G_MEAS, "Home value ÷ county income", "ratio", "OpenHousing", "home_value / county_median_hh_income. Not scored."),
    "ownership_affordable_at_ami80": (G_MEAS, "Owning affordable at 80% AMI", "true/false", "OpenHousing", "True if ownership_burden_ami80 is 30% or less."),
    "rent_affordable_at_ami80": (G_MEAS, "Renting affordable at 80% AMI", "true/false", "OpenHousing", "True if rent_burden_ami80 is 30% or less."),
    "ownership_burden_pctl": (G_SCORE, "Ownership burden percentile", "0-100", "OpenHousing", "Hazen percentile of ownership_burden across towns, flipped so 100 = smallest burden."),
    "rent_burden_pctl": (G_SCORE, "Rent burden percentile", "0-100", "OpenHousing", "Hazen percentile of rent_burden, flipped so 100 = smallest burden."),
    "renters_cost_burdened_pctl": (G_SCORE, "Cost-burdened renters percentile", "0-100", "OpenHousing", "Percentile of renters_cost_burdened (context only)."),
    "ownership_burden_confidence": (G_REL, "Ownership measure confidence", "high/medium/low", "OpenHousing", "Reliability of ownership_burden from the ACS coefficient of variation, capped at medium for ACS home values."),
    "rent_burden_confidence": (G_REL, "Rent measure confidence", "high/medium/low", "OpenHousing", "Reliability of rent_burden from the ACS coefficient of variation."),
    "renters_cost_burdened_confidence": (G_REL, "Cost-burdened share confidence", "high/medium/low", "OpenHousing", "Reliability of renters_cost_burdened."),
    "ownership_score": (G_SCORE, "Ownership score", "0-100", "OpenHousing", "Ownership affordability score (= ownership_burden_pctl). Higher is more affordable."),
    "ownership_rank": (G_SCORE, "Ownership rank", "rank", "OpenHousing", "Rank by ownership_score; 1 = most affordable."),
    "ownership_confidence": (G_REL, "Ownership score confidence", "text", "OpenHousing", "high / medium / low / insufficient data."),
    "ownership_confidence_reasons": (G_REL, "Ownership confidence reasons", "text", "OpenHousing", "Why the ownership confidence is what it is (semicolon-separated)."),
    "rental_score": (G_SCORE, "Rental score", "0-100", "OpenHousing", "Rental affordability score (= rent_burden_pctl). Higher is more affordable."),
    "rental_rank": (G_SCORE, "Rental rank", "rank", "OpenHousing", "Rank by rental_score; 1 = most affordable."),
    "rental_confidence": (G_REL, "Rental score confidence", "text", "OpenHousing", "high / medium / low / insufficient data."),
    "rental_confidence_reasons": (G_REL, "Rental confidence reasons", "text", "OpenHousing", "Why the rental confidence is what it is."),
    "ownership_rank_low": (G_REL, "Ownership rank, likely best", "rank", "OpenHousing", "5th percentile of the ownership rank over 1,000 redraws of the ACS inputs within their margins of error (always includes the published rank)."),
    "ownership_rank_high": (G_REL, "Ownership rank, likely worst", "rank", "OpenHousing", "95th percentile of the ownership rank over the same redraws."),
    "rental_rank_low": (G_REL, "Rental rank, likely best", "rank", "OpenHousing", "5th percentile of the rental rank over 1,000 redraws."),
    "rental_rank_high": (G_REL, "Rental rank, likely worst", "rank", "OpenHousing", "95th percentile of the rental rank over 1,000 redraws."),
    "zri": (G_BAR, "Zoning restrictiveness index", "index", "NZLUD", "NZLUD zoning restrictiveness (higher = more restrictive). 105 towns."),
    "nzlud_min_lot_size": (G_BAR, "Minimum lot size rule", "0/1", "NZLUD", "1 if the town sets a minimum lot size."),
    "nzlud_one_acre_more": (G_BAR, "One-acre-plus minimum lots", "0/1", "NZLUD", "1 if any district requires lots of one acre or more."),
    "nzlud_inclusionary": (G_BAR, "Inclusionary zoning", "0/1", "NZLUD", "1 if the town has inclusionary zoning."),
    "nzlud_open_space": (G_BAR, "Open space requirement", "0/1", "NZLUD", "1 if the town requires open space in developments."),
    "nzlud_adu": (G_BAR, "Accessory units allowed", "0/1", "NZLUD", "1 if accessory dwelling units are allowed anywhere in the town."),
    "nzlud_parking_median": (G_BAR, "Parking required per home", "spaces", "NZLUD", "Median parking spaces required per residential unit."),
    "nzlud_mf_per": (G_BAR, "Districts allowing apartments", "share (0-1)", "NZLUD", "Share of residential districts (incl. mixed use) that allow multifamily housing by right."),
    "zoning_data_available": (G_BAR, "Zoning data available", "true/false", "OpenHousing", "True for the 105 towns NZLUD covers."),
    "housing_region": (G_BAR, "Housing region", "1-6", "DCA", "The state's affordable-housing region (Fourth Round)."),
    "present_need": (G_BAR, "Present need", "homes", "DCA", "Fourth Round present need (October 2024 calculation)."),
    "prospective_need": (G_BAR, "Prospective need (uncapped)", "homes", "DCA", "Fourth Round prospective need before the state's cap."),
    "prospective_need_capped": (G_BAR, "Prospective need", "homes", "DCA", "Fourth Round prospective need after the cap (2025-2035 obligation)."),
    "qualified_urban_aid": (G_BAR, "Qualified Urban Aid", "true/false", "DCA", "True for the 47 towns with no prospective obligation by law."),
    "prospective_need_per_1000_hh": (G_BAR, "Prospective need per 1,000 households", "homes per 1,000 hh", "OpenHousing", "prospective_need_capped / households x 1,000."),
    "total_need_per_1000_hh": (G_BAR, "Total need per 1,000 households", "homes per 1,000 hh", "OpenHousing", "(present_need + prospective_need_capped) / households x 1,000."),
    "data_built": (G_META, "Build date", "date", "OpenHousing", "Date the row was built."),
}


def write(columns: list[str]) -> None:
    missing = [c for c in columns if c not in DICTIONARY]
    if missing:
        raise RuntimeError(f"data dictionary has no entry for: {missing}")
    rows = [{"column": c, "group": DICTIONARY[c][0], "label": DICTIONARY[c][1], "unit": DICTIONARY[c][2],
             "source": DICTIONARY[c][3], "description": DICTIONARY[c][4]} for c in columns]
    pd.DataFrame(rows).to_csv(PUBLISHED / "data_dictionary.csv", index=False)
    (PUBLISHED / "data_dictionary.web.json").write_text(json.dumps({"columns": rows}, separators=(",", ":")) + "\n")
