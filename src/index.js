/**
 * Placeholder: connect to Airtable using AIRTABLE_API_KEY and AIRTABLE_BASE_ID
 */
const apiKey = process.env.AIRTABLE_API_KEY;
const baseId = process.env.AIRTABLE_BASE_ID;
if (!apiKey || !baseId) {
  console.log('Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID to run.');
  process.exit(0);
}
console.log('Job Aggregator Airtable - ready');
