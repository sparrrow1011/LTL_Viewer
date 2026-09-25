"""
pywebview JS API for the LTL Viewer desktop app.

Exposes the manual-sourcing update flows to the frontend:
  - update_cst(): scrape SMC (Playwright/Chromium) and refresh cst_runs.json
  - validate_data() / validate_address_data(): FMC enrichment for VRIDs
  - save_csv() / save_file(): save generated CSV/EML to Downloads
"""

from app.utils.files import save_to_downloads
from scripts.validators import validate_vrid_csv


class Api:
    # -------------------------
    # FILE SAVING
    # -------------------------
    def save_csv(self, filename, content):
        print(f"DEBUG: Saving CSV file: {filename}")
        return save_to_downloads(filename, content)

    def save_file(self, filename, content):
        print(f"DEBUG: Saving file: {filename}")
        return save_to_downloads(filename, content)

    # -------------------------
    # FMC VALIDATION (addresses)
    # -------------------------
    def validate_address_data(self, csv_text):
        from scrapers.fmc import run_address_scrap
        from scripts.fmc_update import update_fmc_address_fields

        df = validate_vrid_csv(csv_text)
        batch_size = 400
        total_rows = len(df)
        for i in range(0, total_rows, batch_size):
            batch_df = df.iloc[i:i + batch_size]
            vrids = batch_df["vrid"].dropna().unique().tolist()
            run_address_scrap(vrids)
            update_fmc_address_fields()
        return f"Validated {df['vrid'].nunique()} VRIDs across {total_rows} rows"

    # -------------------------
    # FMC VALIDATION (execution status / nodes / driver)
    # -------------------------
    def validate_data(self, csv_text):
        from scrapers.fmc_api import run_fmc_api_search
        from scripts.fmc_update import update_fmc_fields_from_api

        df = validate_vrid_csv(csv_text)
        batch_size = 400
        total_rows = len(df)
        for i in range(0, total_rows, batch_size):
            batch_df = df.iloc[i:i + batch_size]
            vrids = batch_df["vrid"].dropna().unique().tolist()
            records = run_fmc_api_search(vrids)
            update_fmc_fields_from_api(records)
        return f"Validated {df['vrid'].nunique()} VRIDs across {total_rows} rows"

    # Alias kept for the "Validate Driver" button in the UI.
    def validate_driver_data(self, csv_text):
        return self.validate_data(csv_text)

    # -------------------------
    # SMC UPDATE FLOW
    # -------------------------
    def update_cst(self):
        from scrapers.smc import run_smc_export
        from scripts.smc_update import update_cst_fields_from_json

        print("DEBUG: Starting SMC update")
        orders = run_smc_export()
        if orders:
            update_cst_fields_from_json(orders)
        else:
            print("DEBUG: SMC export returned no orders; skipping update")
        return "Updated runs successfully"
