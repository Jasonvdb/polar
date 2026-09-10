/* Bounded requests and fail-closed CLI completion for the Paykit scenarios. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(finish, ms);
    function finish() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function operationFailure(name, operation, receiver) {
  const text = value => typeof value === 'string' ? value.slice(0, 2048) : undefined;
  const error = operation.error && { code: text(operation.error.code), message: text(operation.error.message) };
  const currentReceiver = receiver && { id: text(receiver.id), status: text(receiver.status), generation: receiver.generation, lastError: text(receiver.lastError) };
  return `Unexpected ${name} outcome: ${JSON.stringify({ operationId: text(operation.id), status: text(operation.status), error, receiver: currentReceiver })}`;
}

function serviceBase(serviceContainer, docker) {
  const address = docker('port', serviceContainer, '10090/tcp').trim();
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(address);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('Expected one loopback service port mapping');
  }
  return `http://${address}`;
}

async function requestJson(url, options = {}, signal, timeoutMs = 10000) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => { controller.abort(signal.reason); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    // This timer intentionally remains referenced while fetch or body parsing is pending.
    timer = setTimeout(() => {
      const error = new Error(`HTTP request deadline exceeded: ${options.method || 'GET'} ${new URL(url).pathname}`);
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        let data;
        try { data = await response.json(); }
        catch (_) { throw new Error(`Invalid JSON response: ${new URL(url).pathname}`); }
        return { status: response.status, data };
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/* Work must observe the supplied signal at every request, delay and mutation.
 * Cleanup/report callbacks are synchronous, including the emergency exit path.
 * We never race the entire work promise against cleanup. */
function runCli(work, { cleanup = () => ({ completed: true }), complete, fail, timeoutMs = 1200000 } = {}) {
  const controller = new AbortController();
  let settled = false;
  let cleanupResult;
  process.exitCode = 1;
  const cleanupOnce = () => {
    if (!cleanupResult) {
      try { cleanupResult = cleanup(); }
      catch (_) { cleanupResult = { completed: false, error: 'Cleanup callback failed' }; }
    }
    return cleanupResult;
  };
  const failed = error => {
    process.exitCode = 1;
    const result = cleanupOnce();
    try { fail?.(error, result); }
    catch (_) { console.error('Failed to write the failure report'); }
    console.error(`Paykit scenarios failed: ${error.message}`);
    settled = true;
  };
  const incomplete = () => {
    if (!settled) failed(controller.signal.reason || new Error('Process exited before scenario completion'));
  };
  const stop = () => controller.abort(new Error('Scenario run interrupted'));
  const timer = setTimeout(() => controller.abort(new Error('Scenario run deadline exceeded')), timeoutMs);
  process.on('beforeExit', incomplete);
  process.on('exit', incomplete);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return Promise.resolve().then(() => work(controller.signal)).then(result => {
    controller.signal.throwIfAborted();
    const cleaned = cleanupOnce();
    if (cleaned.completed !== true) throw new Error('Owned resource cleanup incomplete');
    complete?.(result, cleaned);
    settled = true;
    process.exitCode = 0;
  }).catch(failed).finally(() => {
    clearTimeout(timer);
    process.removeListener('beforeExit', incomplete);
    process.removeListener('exit', incomplete);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  });
}

module.exports = { sleep, serviceBase, requestJson, runCli, operationFailure };
