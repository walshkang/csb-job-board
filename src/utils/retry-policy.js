async function runWithRetry({
  maxAttempts,
  run,
  classifyFailure,
  isTransient,
  computeDelayMs,
  onRetry,
  onFinalFailure,
  sleep,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await run(attempt);
      return { status: 'success', attempt, result };
    } catch (err) {
      const failureClass = classifyFailure(err);
      const canRetry = attempt < maxAttempts && isTransient(failureClass);
      if (canRetry) {
        const nextDelayMs = computeDelayMs(attempt);
        await onRetry({ attempt, failure_class: failureClass, next_delay_ms: nextDelayMs, err });
        await sleep(nextDelayMs);
        continue;
      }
      await onFinalFailure({ attempt, failure_class: failureClass, err });
      return { status: 'failure', attempt, failure_class: failureClass, err };
    }
  }

  return { status: 'failure', attempt: maxAttempts, failure_class: 'unknown', err: new Error('retry loop exhausted') };
}

module.exports = { runWithRetry };
