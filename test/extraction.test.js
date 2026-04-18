const path = require('path');
const fs = require('fs');
const extraction = require('../src/agents/extraction');

describe('extraction agent helpers', () => {
  test('normalizeEmploymentType returns allowed values or full_time fallback', () => {
    expect(extraction.normalizeEmploymentType('Full Time')).toBe('full_time');
    expect(extraction.normalizeEmploymentType('part-time')).toBe('part_time');
    expect(extraction.normalizeEmploymentType('Intern')).toBe('intern');
    expect(extraction.normalizeEmploymentType('Contract')).toBe('contract');
    expect(extraction.normalizeEmploymentType('Temporary')).toBe('full_time');
    expect(extraction.normalizeEmploymentType(null)).toBe('full_time');
  });

  test('extractJSONFromText handles code fences and trailing commas', () => {
    const input = "```json\n[{\"job_title\":\"A\", \"url\": \"/a\",},]\n```";
    const out = extraction.extractJSONFromText(input);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].job_title).toBe('A');
  });

  test('runExtraction normalizes and resolves urls and preserves nulls when employment_type missing', async () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.html'), 'utf8');
    const llmOutput = JSON.stringify([
      { job_title: 'Engineer', url: '/careers/eng', location: 'Remote', employment_type: null, description: 'Engineer role' },
      { job_title: 'Intern', url: 'https://example.com/jobs/1', location: ['NY', 'SF'], employment_type: 'intern', description: null }
    ]);
    const callFn = async () => llmOutput;
    const res = await extraction.runExtraction({ html, company: 'Example Co', baseUrl: 'https://example.com', callFn });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);
    expect(res[0].url).toBe('https://example.com/careers/eng');
    expect(res[0].employment_type).toBeNull();
    expect(res[1].employment_type).toBe('intern');
    expect(res[1].location).toBe('NY | SF');
  });
});
