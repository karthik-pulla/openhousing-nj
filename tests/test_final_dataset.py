"""The built and published datasets must have exactly one row per municipality."""
import pandas as pd
import pytest

from pipeline.common import EXPECTED_MUNICIPALITIES, PUBLISHED_CSV
from pipeline.index import BUILD


@pytest.mark.parametrize("path", [BUILD / "openhousing_nj.csv", PUBLISHED_CSV], ids=["build", "published"])
def test_dataset_has_exactly_564_rows(path):
    if not path.exists():
        pytest.skip(f"{path} not built yet")
    df = pd.read_csv(path, dtype={"geoid": str})
    assert len(df) == EXPECTED_MUNICIPALITIES
    assert df.geoid.is_unique
