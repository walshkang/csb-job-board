Agents and responsibilities

Overview
Define small, focused agents (processes) per slice. Agents should be idempotent, log outputs, and write artifacts to the repo's data/ or an artifacts/ prefix for later ingestion into Airtable.

1) OCR Agent (Slice 1)
- Input: screenshot image(s)
- Tooling: Gemini 2.5 Flash-Lite for OCR; fallback to Tesseract for offline
- Output: raw OCR JSON per image, then mapped companies.json rows
- Responsibilities: queue images, run OCR, normalize table output, call mapping LLM to convert to Company schema
- Validation: random sample compare vs original screenshots

2) Discovery Agent (Slice 2)
- Input: companies.json
- Tooling: HTTP fetcher (linkup), sitemap parser, LLM fallback for homepage heuristic
- Output: updated companies.json with careers_page fields
- Responsibilities: concurrent fetches with rate limits, detect ATS platforms, mark discovery method
- Validation: follow 200/3xx responses and record reachability

3) Scraper Agent (Slice 3)
- Input: companies with careers_page_url
- Tooling: headless fetcher, per-ATS adapters (Greenhouse, Lever), HTML storage
- Output: raw HTML artifacts + scrape_runs log
- Responsibilities: rotate user agents, backoff on 429, detect partial content and retry

4) Extraction Agent (Slice 4)
- Input: raw HTML artifacts
- Tooling: Claude/Gemma for extraction prompts; structured output to Job schema
- Output: jobs.json (raw-extracted)
- Responsibilities: dedup, compute description_hash, attach metadata about extraction confidence

Extraction Agent (implementation)
- Location: src/agents/extraction.js
- Prompt: src/prompts/extraction.txt (used to instruct the LLM how to parse HTML into a JSON array)
- CLI usage examples:
  - From file: node src/agents/extraction.js --input artifacts/html/<company>.html --company "Acme Inc" --base-url "https://acme.example" --out data/jobs-extracted/acme.json
  - From stdin: cat artifacts/html/acme.html | node src/agents/extraction.js --company "Acme Inc" --base-url "https://acme.example" > data/jobs-extracted/acme.json
- Env vars:
  - ANTHROPIC_API_KEY (required)
  - ANTHROPIC_MODEL (optional; defaults to claude-sonnet-4-5)
- Output: JSON array written to data/jobs-extracted/<company-slug>.json (or --out path). Each entry follows the schema in src/prompts/extraction.txt.
- Notes:
  - The agent trims very large HTML snippets before sending to the LLM; the prompt supports truncated HTML.
  - The agent detects obvious cookie/captcha walls and returns the page_blocked shape described in the prompt.

5) Enrichment Agent (Slice 5)
- Input: jobs.json
- Tooling: Claude for classification and enrichment
- Output: enriched jobs.json, classification fields
- Responsibilities: allow iterative prompt tuning; store prompt versions used per run

6) Temporal Agent (Slice 6)
- Input: historical scrape_runs and jobs
- Tooling: scheduler (cron / GitHub Actions), state machine for lifecycle
- Output: updated jobs.json and companies.json with last_seen_at, removed_at
- Responsibilities: detect dormancy, trigger deeper discovery when consecutive_empty_scrapes exceed threshold

Operational notes
- Artifacts: store in data/ with clear naming: data/companies.json, data/jobs.json, artifacts/html/<company-id>.html
- Secrets: use environment variables and GitHub Secrets; never commit API keys
- CI: add GitHub Actions to run small unit tests, linting, and scheduled scrapes (careful with rate limits)

