function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

class AdaptiveController {
  constructor({
    stage,
    min,
    max,
    target,
    breaker,
    queue,
    getQueueDepth,
    now = () => Date.now(),
    windowMs = 60_000,
  }) {
    this.stage = stage;
    this.min = Math.max(1, Number(min) || 1);
    this.max = Math.max(this.min, Number(max) || this.min);
    this.target = target || { p95MaxMs: 5_000, queueDepthTrigger: 1 };
    this.breaker = breaker || null;
    this.queue = queue || null;
    this.getQueueDepth = typeof getQueueDepth === 'function'
      ? getQueueDepth
      : (() => (this.queue ? this.queue.size : 0));
    this.now = typeof now === 'function' ? now : (() => Date.now());
    this.windowMs = Math.max(5_000, Number(windowMs) || 60_000);
    this.samples = [];
  }

  current() {
    if (!this.queue) return this.min;
    const value = Number(this.queue.concurrency);
    if (!Number.isFinite(value) || value < this.min) return this.min;
    if (value > this.max) return this.max;
    return Math.round(value);
  }

  recordOutcome({ duration_ms, outcome }) {
    const duration = Number(duration_ms);
    const normalizedOutcome = outcome === 'failure' ? 'failure' : 'success';
    if (!Number.isFinite(duration) || duration < 0) return;
    this.samples.push({ ts: this.now(), duration_ms: duration, outcome: normalizedOutcome });
    this._trim();
  }

  tick() {
    this._trim();
    if (!this.queue) return this.snapshot();

    if (this.breaker && typeof this.breaker.state === 'function') {
      const state = this.breaker.state();
      if (state === 'open' || state === 'half_open') return this.snapshot();
    }

    const p95Ms = this._p95Ms();
    const errorRate = this._errorRate();
    const queueDepth = Number(this.getQueueDepth()) || 0;
    const current = this.current();
    let next = current;

    if (
      queueDepth > this.target.queueDepthTrigger &&
      p95Ms != null &&
      p95Ms <= this.target.p95MaxMs &&
      errorRate < 0.1
    ) {
      next = Math.min(this.max, current + 1);
    } else if (
      errorRate >= 0.2 ||
      (p95Ms != null && p95Ms > (1.5 * this.target.p95MaxMs))
    ) {
      next = Math.max(this.min, current - 1);
    }

    if (next !== current) {
      this.queue.concurrency = next;
    }
    return this.snapshot();
  }

  snapshot() {
    this._trim();
    return {
      current: this.current(),
      min: this.min,
      max: this.max,
      p95Ms: this._p95Ms(),
      errorRate: this._errorRate(),
    };
  }

  _trim() {
    const cutoff = this.now() - this.windowMs;
    while (this.samples.length && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }
  }

  _p95Ms() {
    const durations = this.samples.map((s) => s.duration_ms);
    return percentile(durations, 95);
  }

  _errorRate() {
    if (!this.samples.length) return 0;
    const failures = this.samples.filter((s) => s.outcome === 'failure').length;
    return failures / this.samples.length;
  }
}

module.exports = {
  AdaptiveController,
};
