import io
import pandas as pd

MAX_VRIDS = 1500


def validate_vrid_csv(csv_text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(csv_text))

    df.columns = (
        df.columns
        .str.strip()
        .str.lower()
        .str.replace("\ufeff", "", regex=False)
    )

    if "vrid" not in df.columns:
        raise ValueError(
            f"Missing 'vrid' column. Columns present: {df.columns.tolist()}"
        )

    vrid_count = df["vrid"].nunique()
    if vrid_count > MAX_VRIDS:
        raise ValueError(f"Too many VRIDs ({vrid_count}), limit is {MAX_VRIDS}")

    return df
