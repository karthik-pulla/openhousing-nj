import pandas as pd

print("🔄 Starting data merge pipeline...")

# 1. Load the Zoning (NZLUD) dataset
# Using 'latin1' encoding since the file contains special characters
zoning_df = pd.read_csv('nzlud_muni.csv', encoding='latin1')

# Filter zoning data for New Jersey
nj_zoning = zoning_df[zoning_df['statename'].str.upper() == 'NJ'].copy()

# 2. Load the Zillow Home Value Index (ZHVI) dataset
zillow_df = pd.read_csv('City_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv')

# Filter Zillow data for New Jersey
nj_zillow = zillow_df[zillow_df['State'].str.upper() == 'NJ'].copy()

# 3. Clean up the Zillow names to help them match our map shapes
# Zillow often includes 'Township' or 'Borough' in RegionName, or leaves it out.
nj_zillow['match_name'] = nj_zillow['RegionName'].str.lower().str.strip()
nj_zoning['match_name'] = nj_zoning['place'].str.lower().str.replace('township', '').str.replace('borough', '').str.replace('city', '').str.strip()

# Get the most recent home value column from Zillow (the last column in the file)
latest_date_col = zillow_df.columns[-1]
print(f"📅 Pulling latest Zillow market values from: {latest_date_col}")

# Keep only the essential tracking columns from Zillow
nj_zillow_clean = nj_zillow[['match_name', 'RegionName', 'CountyName', latest_date_col]].rename(
    columns={latest_date_col: 'median_home_value'}
)

# 4. Merge the datasets together
# We match them on the cleaned town names
merged_nj_data = pd.merge(nj_zoning, nj_zillow_clean, on='match_name', how='inner')

# Keep only the crucial metrics needed for the REACH index sliders
final_columns = [
    'GEOID', 'place', 'CountyName', 'median_home_value', 
    'zri', 'min_lot_size', 'open_space', 'inclusionary'
]
# Ensure we only export columns that exist in the merge
available_columns = [col for col in final_columns if col in merged_nj_data.columns]
nj_housing_index = merged_nj_data[available_columns]

# 5. Save the final map-ready data file
output_filename = 'nj_housing_index_master.csv'
nj_housing_index.to_csv(output_filename, index=False)

print(f"✅ Success! Cleaned index data saved as: '{output_filename}'")
print(f"📊 Processed data for {len(nj_housing_index)} New Jersey municipalities.")