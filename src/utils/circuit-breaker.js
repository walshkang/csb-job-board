class CircuitBreaker {
  constructor({
    windowSize = 20,
    minSamples = 5,
    threshold = 0.5,
    cooldownMs = 60_000,
    now = () => Date.now(),
  } = {}) {
    this.windowSize = Math.max(1, Number(windowSize) || 20);
    this.minSamples = Math.max(1, Number(minSamples) || 5);
    this.threshold = Number(threshold);
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 60_000);
    this.now = typeof now === 'function' ? now : (() => Date.now());

    this._state = 'closed';
    this._openedAt = null;
    this._samples = [];
    this._halfOpenProbeConsumed = false;
  }

  record(outcome) {
    if (outcome !== 'success' && outcome !== 'failure') return;

    if (this._state === 'half_open') {
      if (outcome === 'success') {
        this._close();
      } else {
        this._open();
      }
      return;
    }

    this._pushSample(outcome);
    this._evaluateClosedWindow();
  }

  state() {
    if (this._state === 'open' && this._cooldownElapsed()) {
      this._state = 'half_open';
      this._halfOpenProbeConsumed = false;
    }
    return this._state;
  }

  allow() {
    const currentState = this.state();
    if (currentState === 'closed') return true;
    if (currentState === 'open') return false;

    if (!this._halfOpenProbeConsumed) {
      this._halfOpenProbeConsumed = true;
      return true;
    }
    return false;
  }

  reset() {
    this._close();
  }

  snapshot() {
    const state = this.state();
    const failures = this._samples.filter((outcome) => outcome === 'failure').length;
    const samples = this._samples.length;
    const failureRate = samples > 0 ? failures / samples : 0;

    return {
      state,
      failureRate,
      samples,
      openedAt: this._openedAt,
      nextProbeAt: this._openedAt == null ? null : this._openedAt + this.cooldownMs,
    };
  }

  _pushSample(outcome) {
    this._samples.push(outcome);
    if (this._samples.length > this.windowSize) {
      this._samples = this._samples.slice(this._samples.length - this.windowSize);
    }
  }

  _evaluateClosedWindow() {
    if (this._samples.length < this.minSamples) return;
    const failures = this._samples.filter((outcome) => outcome === 'failure').length;
    const failureRate = failures / this._samples.length;
    if (failureRate >= this.threshold) {
      this._open();
    }
  }

  _cooldownElapsed() {
    if (this._openedAt == null) return false;
    return this.now() >= (this._openedAt + this.cooldownMs);
  }

  _open() {
    this._state = 'open';
    this._openedAt = this.now();
    this._halfOpenProbeConsumed = false;
  }

  _close() {
    this._state = 'closed';
    this._openedAt = null;
    this._samples = [];
    this._halfOpenProbeConsumed = false;
  }
}

module.exports = {
  CircuitBreaker,
};
