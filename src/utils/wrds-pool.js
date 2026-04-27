const { Client: SSHClient } = require('ssh2');
const { Client: PGClient } = require('pg');
const config = require('../config');

let sshClient = null;
let pgClient = null;
let connectionPromise = null;

/**
 * Establishes an SSH tunnel and connects the PostgreSQL client through it.
 * Uses the configuration provided in config.wrds.
 * Reuses the existing connection if already established.
 */
async function connect() {
  if (pgClient) return;

  // Use connectionPromise to prevent race conditions during concurrent connect calls
  if (connectionPromise) {
    await connectionPromise;
    return;
  }

  connectionPromise = (async () => {
    const wrds = config.wrds || {};
    if (!wrds.username || !wrds.password) {
      throw new Error('Missing WRDS credentials in configuration.');
    }

    // 1. SSH into WRDS Cloud
    sshClient = new SSHClient();
    await new Promise((resolve, reject) => {
      sshClient
        .on('ready', resolve)
        .on('error', (err) => reject(new Error(`SSH connection failed: ${err.message}`)))
        .on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
          const responses = prompts.map(p => {
            const lower = p.prompt.toLowerCase();
            if (lower.includes('password')) {
              return wrds.password;
            }
            if (lower.includes('passcode') || lower.includes('option') || lower.includes('duo')) {
              console.log('[wrds-ingest] Waiting for Duo MFA approval on your phone...');
              return '1'; // Typically '1' triggers the Duo Push
            }
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
          readyTimeout: 15000,
        });
    });

    // 2. Open TCP tunnel from SSH server to PostgreSQL
    const stream = await new Promise((resolve, reject) => {
      sshClient.forwardOut(
        '127.0.0.1', 0,
        wrds.pgHost, wrds.pgPort,
        (err, str) => (err ? reject(new Error(`SSH tunnel failed: ${err.message}`)) : resolve(str))
      );
    });

    // Decorate the stream so the pg client doesn't crash
    if (typeof stream.setNoDelay !== 'function') {
      stream.setNoDelay = function () {};
    }
    if (typeof stream.setKeepAlive !== 'function') {
      stream.setKeepAlive = function () {};
    }
    if (typeof stream.connect !== 'function') {
      stream.connect = function () {
        // Emit 'connect' asynchronously so pg has time to set up event listeners
        process.nextTick(() => stream.emit('connect'));
      };
    }
    if (typeof stream.destroy !== 'function') {
      stream.destroy = function () {};
    }

    // 3. Connect pg through the tunnel stream
    pgClient = new PGClient({
      user: wrds.username,
      password: wrds.password,
      database: wrds.database,
      ssl: { rejectUnauthorized: false }, // Internal traffic over SSH tunnel
      stream,
      statement_timeout: 30000,
    });

    await pgClient.connect();
  })();

  try {
    await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

/**
 * Executes a PostgreSQL query through the pooled WRDS connection.
 * Connects automatically if not already connected.
 * 
 * @param {string} sql - The query string.
 * @param {Array} params - The query parameters.
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(sql, params = []) {
  if (!pgClient) {
    await connect();
  }
  return pgClient.query(sql, params);
}

/**
 * Tears down the PostgreSQL client and the SSH tunnel.
 * Safe to call even if not connected.
 */
async function close() {
  if (pgClient) {
    try {
      // Do not await to prevent hanging if connection never finished cleanly
      pgClient.end();
    } catch (err) {
      // Ignore
    }
    pgClient = null;
  }
  if (sshClient) {
    try {
      sshClient.end();
    } catch (err) {
      // Ignore
    }
    sshClient = null;
  }
}

module.exports = {
  connect,
  query,
  close,
};
