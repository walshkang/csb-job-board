/**
 * LLM Telemetry — transparent instrumentation for all LLM calls.
 *
 * Tracks per-call: latency, prompt/response size, model, provider, success/failure.
 * Accumulates in-memory and optionally flushes to JSONL on disk.
 *
 * Usage:
 *   const telemetry = LLMTelemetry.instance();
 *   const span = telemetry.start({ model, provider, agent, prompt });
 *   // ... do LLM call ...
 *   span.end({ success: true, response_chars: result.length });
 *
 *   // Later:
 *   telemetry.summarize()  → per-agent, per-model aggregates
 *   telemetry.flush(path)  → write JSONL to disk
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, 'data', 'runs');

let _instance = null;

class LLMTelemetry {
  constructor() {
    this.spans = [];
    this.runId = null;
    this._stream = null;
  }

  static instance() {
    if (!_instance) _instance = new LLMTelemetry();
    return _instance;
  }

  /** Reset for a new benchmark run. */
  reset(runId = null) {
    this.spans = [];
    this.runId = runId || crypto.randomBytes(4).toString('hex');
    if (this._stream) {
      try { this._stream.end(); } catch (_) {}
    }
    this._stream = null;
    return this;
  }

  /** Enable live JSONL streaming to a file. Call after reset(). */
  enableStreaming(filePath) {
    if (!filePath) {
      try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch (_) {}
      filePath = path.join(RUNS_DIR, `llm-telemetry-${this.runId}.jsonl`);
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) {}
    this._stream = fs.createWriteStream(filePath, { flags: 'a' });
    this._streamPath = filePath;
    return this;
  }

  /**
   * Start a new telemetry span.
   * @param {object} opts - { model, provider, agent, prompt }
   *   agent: a label like 'extraction', 'enrichment', 'discovery', 'categorizer'
   * @returns {{ end: Function }} span object
   */
  start(opts = {}) {
    const span = {
      id: crypto.randomBytes(6).toString('hex'),
      run_id: this.runId,
      agent: opts.agent || opts._agent || null,
      model: opts.model || null,
      provider: opts.provider || 'gemini',
      prompt_chars: typeof opts.prompt === 'string' ? opts.prompt.length : 0,
      started_at: new Date().toISOString(),
      start_ts: Date.now(),
      // filled on end():
      latency_ms: null,
      response_chars: null,
      success: null,
      error: null,
      retries: 0,
    };

    const self = this;
    return {
      /** Mark this span as complete. */
      end(result = {}) {
        span.latency_ms = Date.now() - span.start_ts;
        span.success = result.success !== undefined ? result.success : true;
        span.response_chars = result.response_chars || 0;
        span.error = result.error || null;
        span.retries = result.retries || 0;
        span.ended_at = new Date().toISOString();

        // Remove internal timing field
        delete span.start_ts;

        self.spans.push(span);

        // Stream to disk if enabled
        if (self._stream) {
          try { self._stream.write(JSON.stringify(span) + '\n'); } catch (_) {}
        }

        return span;
      },
      /** Access the span data directly. */
      data: span,
    };
  }

  /**
   * Returns aggregate stats grouped by agent and model.
   */
  summarize() {
    const byAgent = {};
    const byModel = {};
    const overall = {
      total_calls: this.spans.length,
      successful: 0,
      failed: 0,
      total_latency_ms: 0,
      total_prompt_chars: 0,
      total_response_chars: 0,
      avg_latency_ms: 0,
    };

    for (const s of this.spans) {
      // Overall
      if (s.success) overall.successful++; else overall.failed++;
      overall.total_latency_ms += s.latency_ms || 0;
      overall.total_prompt_chars += s.prompt_chars || 0;
      overall.total_response_chars += s.response_chars || 0;

      // By agent
      const agent = s.agent || 'unknown';
      if (!byAgent[agent]) byAgent[agent] = this._emptyBucket();
      this._addToBucket(byAgent[agent], s);

      // By model
      const model = s.model || 'unknown';
      if (!byModel[model]) byModel[model] = this._emptyBucket();
      this._addToBucket(byModel[model], s);
    }

    overall.avg_latency_ms = overall.total_calls > 0
      ? Math.round(overall.total_latency_ms / overall.total_calls)
      : 0;

    // Finalize per-bucket averages
    for (const b of [...Object.values(byAgent), ...Object.values(byModel)]) {
      b.avg_latency_ms = b.total_calls > 0 ? Math.round(b.total_latency_ms / b.total_calls) : 0;
    }

    // Percentiles on overall latencies
    const latencies = this.spans.map(s => s.latency_ms || 0).sort((a, b) => a - b);
    overall.p50_ms = this._percentile(latencies, 0.5);
    overall.p95_ms = this._percentile(latencies, 0.95);
    overall.p99_ms = this._percentile(latencies, 0.99);

    // Estimated cost (rough Gemini Flash pricing: $0.075/1M input chars, $0.30/1M output chars)
    overall.estimated_cost_usd = this._estimateCost(overall.total_prompt_chars, overall.total_response_chars);

    return { overall, byAgent, byModel };
  }

  /**
   * Get raw latencies per stage/agent for external analysis.
   */
  latenciesByAgent() {
    const result = {};
    for (const s of this.spans) {
      const agent = s.agent || 'unknown';
      if (!result[agent]) result[agent] = [];
      result[agent].push(s.latency_ms || 0);
    }
    return result;
  }

  /**
   * Write all spans to a JSONL file (batch flush).
   */
  flush(filePath) {
    if (!filePath) {
      try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch (_) {}
      filePath = path.join(RUNS_DIR, `llm-telemetry-${this.runId || 'default'}.jsonl`);
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) {}
    const lines = this.spans.map(s => JSON.stringify(s)).join('\n') + '\n';
    fs.writeFileSync(filePath, lines, 'utf8');
    return filePath;
  }

  /**
   * Close any open streams.
   */
  close() {
    if (this._stream) {
      try { this._stream.end(); } catch (_) {}
      this._stream = null;
    }
  }

  // --- internal helpers ---

  _emptyBucket() {
    return {
      total_calls: 0,
      successful: 0,
      failed: 0,
      total_latency_ms: 0,
      total_prompt_chars: 0,
      total_response_chars: 0,
      avg_latency_ms: 0,
    };
  }

  _addToBucket(bucket, span) {
    bucket.total_calls++;
    if (span.success) bucket.successful++; else bucket.failed++;
    bucket.total_latency_ms += span.latency_ms || 0;
    bucket.total_prompt_chars += span.prompt_chars || 0;
    bucket.total_response_chars += span.response_chars || 0;
  }

  _percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  _estimateCost(promptChars, responseChars) {
    // Rough estimate: ~4 chars per token for English
    // Gemini Flash: $0.075/1M input tokens, $0.30/1M output tokens
    const inputTokens = promptChars / 4;
    const outputTokens = responseChars / 4;
    const cost = (inputTokens * 0.075 / 1e6) + (outputTokens * 0.30 / 1e6);
    return Math.round(cost * 10000) / 10000; // 4 decimal places
  }
}

module.exports = { LLMTelemetry };
