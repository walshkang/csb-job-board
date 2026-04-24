const { liteparseJsonToTabulaPages } = require('../src/agents/ocr');

describe('liteparseJsonToTabulaPages', () => {
  test('converts canonical LiteParse pages.textItems into tabula-like pages', () => {
    const parsed = {
      pages: [
        {
          pageNum: 1,
          textItems: [
            { text: 'Company Name', x: 10, y: 10 },
            { text: 'Website', x: 120, y: 10 },
            { text: 'Acme Energy', x: 10, y: 20 },
            { text: 'acme.com', x: 120, y: 20 },
          ],
        },
      ],
    };

    const out = liteparseJsonToTabulaPages(parsed);
    expect(out).toHaveLength(1);
    expect(out[0].data).toHaveLength(2);
    expect(out[0].data[0].map(c => c.text)).toEqual(['Company Name', 'Website']);
    expect(out[0].data[1].map(c => c.text)).toEqual(['Acme Energy', 'acme.com']);
  });

  test('falls back to recursive coordinate discovery when textItems are absent', () => {
    const parsed = {
      doc: {
        blocks: [
          {
            page: 2,
            lines: [
              {
                tokens: [
                  { content: 'Beta Grid', left: 9, top: 11 },
                  { content: 'beta.io', left: 140, top: 11 },
                ],
              },
            ],
          },
        ],
      },
    };

    const out = liteparseJsonToTabulaPages(parsed);
    expect(out).toHaveLength(1);
    expect(out[0].page).toBe(2);
    expect(out[0].data).toHaveLength(1);
    expect(out[0].data[0].map(c => c.text)).toEqual(['Beta Grid', 'beta.io']);
  });
});
