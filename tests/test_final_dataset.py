"""The published dataset must have exactly one row per municipality.

The file is produced from Phase 3 on. Until then this test is skipped; once
the file exists, any row count other than 564 fails the build.
"""
import pandas as pd
import pytest

from pipeline.common import EXPECTED_MUNICIPALITIES, PUBLISHED_CSV


def test_final_dataset_has_exactly_564_rows():
    if not PUBLISHED_CSV.exists():
        pytest.skip(f"{PUBLISHED_CSV.name} not built yet (Phase 3)")
    df = pd.read_csv(PUBLISHED_CSV, dtype={"geoid": str})
    assert len(df) == EXPECTED_MUNICIPALITIES
    assert df.geoid.is_unique
