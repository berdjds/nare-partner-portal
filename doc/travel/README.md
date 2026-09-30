# WAControl B2B module handoff

> **Status (2026-09-28):** the module specified by this handoff is implemented
> in this repository (since 2026-09-21). See `IMPLEMENTATION.md` for the
> decision record and known limitations (including: `RateVersion.weekdays` /
> `minStay` are stored but not enforced) and `OPERATOR-GUIDE.md` for run
> instructions. The rest of this file is the original handoff description.

1. Read WAControl-B2B-Module-Plan.md for the detailed workbook audit and improved specification.
2. Give Kimi the existing WAControl repository, the original Tour Calculator v12.xlsm, this plan and Kimi-Master-Prompt.md. Paste the master prompt into Kimi to begin.
3. Workbook-Evidence.json contains all populated source cells, expanded formulas, cached values, defined names, validations, image anchors and extracted ResetForm VBA. Formula-inventory.json is the formula-only index.

This handoff specifies an addition to the existing application. The repository itself was not inspected or modified here. The workbook was not modified, macros were not executed, and native Excel recalculation was not performed. Selected arithmetic fixtures were independently checked. All 67 agreement images were surveyed and OCR processed, but contract rate data still needs verification before production import.

Source SHA-256: 02cf436b72a7698a8e45b5bab4195d1023d162bbbe45d40b3df248a3fa4483f8

The source workbook is not duplicated in this archive. Retain it alongside the handoff for the original agreements and image evidence.
