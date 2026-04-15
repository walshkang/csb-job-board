---
type: input_directory
pipeline_stage: "Slice 1"
target_output: "companies.json"
processing_command: "npm run ocr -- data/images"
valid_formats:
  - ".pdf"
  - ".png"
  - ".jpg"
  - ".jpeg"
schema:
  - column: "Company Name"
    required: true
    type: string
    description: "Company name; in screenshots the header includes row count e.g. 'Companies (N,NNN)'"
  - column: "Keywords"
    required: false
    type: string_array
    description: "Comma-separated PitchBook keyword tags; may be truncated with ellipsis"
  - column: "Website"
    required: true
    type: string_domain
    description: "Company domain; used to derive the canonical company ID"
  - column: "Employees"
    required: false
    type: integer
    description: "Headcount integer"
  - column: "Last Financing Size"
    required: false
    type: currency
    description: "Most recent round size in millions"
  - column: "Last Financing Date"
    required: false
    type: date_string
    description: "Date string as shown in PitchBook; may be prefixed 'Expected'"
  - column: "Last Financing Deal Type"
    required: false
    type: string
    description: "e.g. 'Series B', 'Seed', 'Equity Crowdfunding'"
  - column: "Total Raised"
    required: false
    type: currency
    description: "Cumulative funding in millions"
  - column: "HQ Location"
    required: false
    type: string
    description: "City/state or city/country"
  - column: "Primary PitchBook Industry Code"
    required: false
    type: string
    description: "Industry category; may be truncated in PDF exports"
excluded_content:
  - "PitchBook charts, deal flow views, company profile pages, or investor pages"
  - "Screenshots from other data tools (Crunchbase, LinkedIn, etc.)"
  - "Non-tabular images (logos, documents, etc.)"
---

# data/images — PitchBook Inputs

This folder contains PitchBook company list exports (PDFs or screenshots) that feed Slice 1 of the pipeline (OCR → `companies.json`). PDFs are preferred — they contain a text layer so no vision API call is needed.

## Expected Format

Inputs must be PitchBook **Companies & Deals Screener** exports. Columns may vary; required columns are Company Name and Website. The OCR agent will warn (`[WARN]`) if required columns are missing.

| Column | Required | Notes |
| :--- | :---: | :--- |
| **Company Name** | ✅ Yes | In screenshots: header shows "Companies (N,NNN)" |
| **Website** | ✅ Yes | Used to derive canonical company ID |
| **Keywords** | ❌ No | Comma-separated tags; may be truncated |
| **Employees** | ❌ No | Headcount integer |
| **Last Financing Date** | ❌ No | May be prefixed "Expected" |
| **Last Financing Deal Type** | ❌ No | e.g. "Seed Round", "Later Stage VC" |
| **Last Financing Size** | ❌ No | Most recent round in millions |
| **Total Raised** | ❌ No | Cumulative funding in millions |
| **HQ Location** | ❌ No | City/state or city/country |
| **Primary PitchBook Industry Code** | ❌ No | May be truncated in PDF exports |

## How to Export from PitchBook

**PDF (preferred):**
1. Run your Companies & Deals Screener query with desired filters.
2. Click **Download → PDF**. PitchBook exports up to 250 companies per PDF.
3. Drop the file in this folder and run `npm run ocr -- data/images`.

**Screenshot (fallback):**
1. Ensure the columns above are visible in the results table.
2. Take a full-page screenshot (PNG or JPG). Partial rows are fine.
3. Drop in this folder and run `npm run ocr -- data/images`.

## What Does NOT Belong Here

- PitchBook charts, deal flow views, company profile pages, or investor pages
- Screenshots from other data tools (Crunchbase, LinkedIn, etc.)
- Non-tabular images (logos, documents, etc.)
