#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

let pg;
try {
  pg = require('pg');
} catch {
  console.error('pg module not installed. Run: npm install pg');
  process.exit(1);
}

const { Pool } = pg;

function quoteIdentifier(ident) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function formatValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
    console.error('Missing WRDS credentials. Set WRDS_USERNAME and WRDS_PASSWORD.');
    process.exit(1);
  }

  let pool;
  try {
    pool = new Pool({
      host: config.wrds.host,
      port: config.wrds.port,
      user: config.wrds.username,
      password: config.wrds.password,
      database: config.wrds.database,
      ssl: { rejectUnauthorized: true },
      max: 2,
      connectionTimeoutMillis: 15000,
      statement_timeout: 30000,
    });

    const schema = config.wrds.schema;
    const tablesResult = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema]
    );
    const tables = tablesResult.rows.map(r => r.table_name);

    const columnsResult = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [schema]
    );
    const columns = columnsResult.rows.map(r => ({
      table: r.table_name,
      column: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable,
      max_length: r.character_maximum_length,
    }));

    let sampleRows = [];
    const firstTable = tables[0];
    if (firstTable) {
      const sampleQuery = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(firstTable)} LIMIT 3`;
      try {
        const sampleResult = await pool.query(sampleQuery);
        sampleRows = sampleResult.rows;
      } catch (err) {
        console.error(`Sample query failed for ${schema}.${firstTable}: ${err.message}`);
      }
    }

    const output = {
      discovered_at: new Date().toISOString(),
      schema,
      tables,
      columns,
      sample_rows: sampleRows,
    };

    const outputPath = path.join(__dirname, '../artifacts/wrds-schema-map.json');
    await writeJsonAtomic(outputPath, output);

    console.log(`Tables found: ${tables.length}`);
    for (const tableName of tables) {
      const tableColumns = columns.filter(c => c.table === tableName);
      const names = tableColumns.map(c => c.column).join(', ');
      console.log(`${tableName}: ${tableColumns.length} columns`);
      console.log(`  ${names}`);
    }

    if (sampleRows.length > 0) {
      console.log(`Sample rows from ${firstTable}:`);
      sampleRows.forEach((row, index) => {
        const firstThree = Object.entries(row)
          .slice(0, 3)
          .map(([key, value]) => `${key}=${formatValue(value)}`);
        console.log(`  Row ${index + 1}: ${firstThree.join(', ')}`);
      });
    } else {
      console.log('Sample rows: none');
    }

    console.log(`Wrote schema map: ${outputPath}`);
  } catch (err) {
    console.error(`WRDS connection failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch (err) {
        console.error(`Failed to close WRDS connection pool: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main();
