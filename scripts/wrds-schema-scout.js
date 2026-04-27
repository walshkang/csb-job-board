#!/usr/bin/env node

/**
 * WRDS Schema Scout — Connection validation + tag enumeration.
 *
 * Connects to WRDS via SSH tunnel (wrds-cloud.wharton.upenn.edu:22),
 * forwards to PostgreSQL (wrds-pgdata.wharton.upenn.edu:9737),
 * and enumerates distinct classification tag values from pitchbk.company.
 *
 * Usage:
 *   npm run wrds-scout
 *   npm run wrds-scout -- --sample     # also show 5 sample rows
 *
 * Requires:  WRDS_USERNAME + WRDS_PASSWORD in .env.local
 *            npm install pg ssh2
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

let pg, ssh2;
try {
  pg = require('pg');
} catch {
  console.error('pg module not installed. Run: npm install pg');
  process.exit(1);
}
try {
  ssh2 = require('ssh2');
} catch {
  console.error('ssh2 module not installed. Run: npm install ssh2');
  process.exit(1);
}

const { Client: PGClient } = pg;
const { Client: SSHClient } = ssh2;

const SHOW_SAMPLE = process.argv.includes('--sample');

// Classification columns to enumerate distinct values for
const TAG_COLUMNS = [
  'emergingspaces',
  'verticals',
  'primaryindustrycode',
  'primaryindustrygroup',
  'primaryindustrysector',
];

function quoteIdentifier(ident) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

async function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await fs.promises.writeFile(tmpPath, json, 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

async function main() {
  const wrds = config.wrds || {};
  if (!wrds.username || !wrds.password) {
    console.error('Missing WRDS credentials. Set WRDS_USERNAME and WRDS_PASSWORD in .env.local');
    process.exit(1);
  }

  let sshClient, pgClient;

  try {
    // ── Step 1: SSH into WRDS Cloud ─────────────────────────────────────
    console.log(`Connecting via SSH to ${wrds.sshHost}:${wrds.sshPort}...`);
    sshClient = new SSHClient();
    await new Promise((resolve, reject) => {
      sshClient
        .on('ready', () => {
          console.log('SSH connection established.');
          resolve();
        })
        .on('error', (err) => reject(new Error(`SSH connection failed: ${err.message}`)))
        .on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
          console.log(`SSH Keyboard Interactive: name="${name}", instructions="${instructions}"`);
          prompts.forEach((p, i) => console.log(`  Prompt ${i}: "${p.prompt}" (echo=${p.echo})`));

          const responses = prompts.map(p => {
            const lower = p.prompt.toLowerCase();
            if (lower.includes('password')) {
              console.log('  -> Responding with password');
              return wrds.password;
            }
            console.log(`  -> Responding with empty string for prompt: "${p.prompt}"`);
            return '';
          });
          finish(responses);
        })
        .connect({
          host: wrds.sshHost,
          port: wrds.sshPort,
          username: wrds.username,
          password: wrds.password,
          agent: process.env.SSH_AUTH_SOCK,
          tryKeyboard: true,
          debug: (msg) => console.log(`[SSH Debug] ${msg}`),
          readyTimeout: 15000,
        });
      console.log('  ... Connect call initiated.');
    });

    // ── Step 2: TCP tunnel to PostgreSQL ─────────────────────────────────
    console.log(`Opening tunnel to ${wrds.pgHost}:${wrds.pgPort}...`);
    const stream = await new Promise((resolve, reject) => {
      sshClient.forwardOut(
        '127.0.0.1', 0,
        wrds.pgHost, wrds.pgPort,
        (err, stream) => err ? reject(new Error(`SSH tunnel failed: ${err.message}`)) : resolve(stream)
      );
    });
    console.log('SSH tunnel open.');

    // Add dummy methods because the pg client expects a net.Socket
    if (typeof stream.setNoDelay !== 'function') {
      stream.setNoDelay = function () {};
    }
    if (typeof stream.setKeepAlive !== 'function') {
      stream.setKeepAlive = function () {};
    }
    if (typeof stream.connect !== 'function') {
      stream.connect = function () {
        process.nextTick(() => stream.emit('connect'));
      };
    }
    if (typeof stream.destroy !== 'function') {
      stream.destroy = function () {};
    }

    // ── Step 3: Connect pg through tunnel ───────────────────────────────
    pgClient = new PGClient({
      user: wrds.username,
      password: wrds.password,
      database: wrds.database,
      ssl: { rejectUnauthorized: false }, // WRDS requires SSL, allow self-signed over tunnel
      stream,
      statement_timeout: 30000,
    });
    await pgClient.connect();
    console.log('PostgreSQL connected through tunnel.\n');

    const schema = wrds.schema;
    const table = wrds.table;
    const fqTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    // ── Step 4: Row count ───────────────────────────────────────────────
    const countResult = await pgClient.query(`SELECT COUNT(*) AS cnt FROM ${fqTable}`);
    console.log(`Total rows in ${schema}.${table}: ${countResult.rows[0].cnt}\n`);

    // ── Step 5: Enumerate classification tags ───────────────────────────
    const tagEnumeration = {};

    for (const col of TAG_COLUMNS) {
      console.log(`Enumerating DISTINCT ${col}...`);
      try {
        const result = await pgClient.query(
          `SELECT DISTINCT ${quoteIdentifier(col)} AS val
           FROM ${fqTable}
           WHERE ${quoteIdentifier(col)} IS NOT NULL
             AND TRIM(${quoteIdentifier(col)}) <> ''
           ORDER BY val
           LIMIT 500`
        );
        const values = result.rows.map(r => r.val);
        tagEnumeration[col] = values;
        console.log(`  → ${values.length} distinct values`);
        // Show first 5 as preview
        values.slice(0, 5).forEach(v => console.log(`    • ${v}`));
        if (values.length > 5) console.log(`    ... (${values.length - 5} more)`);
      } catch (err) {
        console.error(`  → ERROR: ${err.message}`);
        tagEnumeration[col] = { error: err.message };
      }
      console.log();
    }

    // ── Step 6: Sample rows (optional) ──────────────────────────────────
    let sampleRows = [];
    if (SHOW_SAMPLE) {
      console.log('Fetching 5 sample rows...');
      const sampleResult = await pgClient.query(
        `SELECT companyid, companyname, website, emergingspaces, verticals,
                primaryindustrycode, primaryindustrygroup, primaryindustrysector,
                keywords, description
         FROM ${fqTable}
         WHERE emergingspaces IS NOT NULL
         LIMIT 5`
      );
      sampleRows = sampleResult.rows;
      sampleRows.forEach((row, i) => {
        console.log(`\n  Row ${i + 1}: ${row.companyname}`);
        console.log(`    website: ${row.website}`);
        console.log(`    emergingspaces: ${row.emergingspaces}`);
        console.log(`    verticals: ${row.verticals}`);
        console.log(`    primaryindustrycode: ${row.primaryindustrycode}`);
        console.log(`    keywords: ${(row.keywords || '').substring(0, 120)}...`);
      });
      console.log();
    }

    // ── Step 7: Write output ────────────────────────────────────────────
    const output = {
      discovered_at: new Date().toISOString(),
      schema,
      table,
      total_rows: parseInt(countResult.rows[0].cnt, 10),
      tag_enumeration: tagEnumeration,
      ...(sampleRows.length > 0 ? { sample_rows: sampleRows } : {}),
    };

    const outputPath = path.join(__dirname, '../artifacts/wrds-schema-map.json');
    await writeJsonAtomic(outputPath, output);
    console.log(`Wrote tag enumeration to ${outputPath}`);

  } catch (err) {
    console.error(`WRDS scout failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    // Teardown: pg first, then SSH
    if (pgClient) {
      try { 
        pgClient.end(); // Do not await to prevent hanging if connection never finished
      } catch (err) {
        console.error(`Failed to close pg: ${err.message}`);
      }
    }
    if (sshClient) {
      try { sshClient.end(); } catch (err) {
        console.error(`Failed to close SSH: ${err.message}`);
      }
    }
  }
}

main();
