# data/images — PitchBook Screenshot Inputs

This folder contains PitchBook company list screenshots that feed Slice 1 (OCR → companies.json).

## Expected screenshot format

Screenshots must be PitchBook **company list exports** with the following columns visible (order may vary):

| Column | Required | Notes |
|---|---|---|
| Companies (N,NNN) | yes | Company name; header includes row count |
| Keywords | yes | Comma-separated PitchBook keyword tags; may be truncated with ellipsis |
| Website | yes | Company domain; used to derive the canonical company ID |
| Employees | no | Headcount integer |
| Last Financing ($) | no | Most recent round size |
| Last Financing Date | no | Date string as shown in PitchBook |
| Last Financing Deal Type | no | e.g. "Series B", "Seed", "Equity Crowdfunding" |
| Total Raised | no | Cumulative funding |
| HQ Location | no | City/state or city/country |

## How to produce a valid screenshot

1. In PitchBook, run your climate/clean-tech company query.
2. In the results table, ensure the **Keywords** column is visible (add it via column picker if needed).
3. Scroll to show a full page of rows with headers visible.
4. Take a screenshot (PNG or JPG). Partial rows at the top/bottom are fine — OCR will flag uncertain values.
5. Drop the file in this folder and run `npm run ocr -- data/images`.

## What does NOT belong here

- PitchBook charts, deal flow views, company profile pages, or investor pages
- Screenshots from other data tools (Crunchbase, LinkedIn, etc.)
- Non-tabular images (logos, documents, etc.)

The OCR agent will warn in the console (`[WARN]`) if a screenshot is missing required columns or appears non-tabular.
