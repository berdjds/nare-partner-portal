#!/usr/bin/env python3
"""Read-only export of the pricing configuration needed to prove traveller/pricing rules.

    python3 scripts/export-templates-readonly.py /path/to/production.db > templates-export.json

The SQLite file is opened with mode=ro (no writes possible). The export contains NO client, agency,
request, user, contact or credential data: only template, catalogue, rate, FX and policy tables.
SELECT * is used so the production schema as deployed today (fewer columns than this branch) is fine.
"""
import datetime, json, sqlite3, sys, urllib.parse

TABLES = ["PackageTemplate", "TemplateVersion", "ServiceProduct", "RateVersion", "HotelProduct",
          "VehicleType", "FXRateVersion", "PricingPolicyVersion"]

def main(path):
    con = sqlite3.connect("file:" + urllib.parse.quote(path) + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out = {"exportedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "tables": {}}
    for t in TABLES:
        out["tables"][t] = [dict(r) for r in con.execute(f'SELECT * FROM "{t}"')]
    out["tables"]["TravelSettings"] = [dict(r) for r in con.execute('SELECT id, companyTz, defaultPolicyId FROM "TravelSettings"')]
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1, default=str)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: export-templates-readonly.py /path/to/db.sqlite")
    main(sys.argv[1])
