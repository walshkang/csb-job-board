Job Aggregator (Airtable backend)

A job aggregation tool that collects company and job data (JSON-rich) and stores it in Airtable as the backend.

Features
- Gather job listings and company metadata into JSON files
- Save and sync records to Airtable

Setup
1. Create an Airtable API key and Base ID.
2. Set environment variables: AIRTABLE_API_KEY and AIRTABLE_BASE_ID.
3. Copy config.example.json to config.json and edit table names if needed.

Security
- Do NOT commit your Airtable API keys. Use environment variables or a secrets store.

License: MIT
