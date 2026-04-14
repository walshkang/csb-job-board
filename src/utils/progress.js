class Progress {
  constructor(total, label) {
    this.total = Number(total) || 0;
    this.label = String(label || '');
  }

  tick(current, detail = '') {
    const curr = Number(current) || 0;
    const pct = this.total > 0 ? Math.round((curr / this.total) * 100) : 0;
    let d = String(detail || '').replace(/\s+/g, ' ').trim();
    if (d.length > 60) d = d.slice(0, 57) + '...';
    const line = `[${this.label}] ${curr}/${this.total} (${pct}%) ${d}`;
    try { process.stderr.write('\r' + line); } catch (e) { /* swallow */ }
  }

  done() {
    try { process.stderr.write('\n'); } catch (e) { /* swallow */ }
  }
}

module.exports = Progress;
