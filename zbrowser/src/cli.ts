/**
 * zb — loopback CLI for zbrowserd. The backend runs
 *   node zb.cjs <endpoint> '<json>' [timeoutMs]
 * inside the sandbox and parses the single `ZB_JSON:` line on stdout.
 *
 * Exit code is 0 whenever the daemon answered (even with ok:false — that is a
 * logical result the backend must read), 2 when the daemon is unreachable.
 */
import * as http from 'node:http';
import { ZB_DAEMON_PORT, encodeZbLine } from './protocol';

/** stdout to a pipe is async in Node — process.exit() right after write()
 *  truncates anything past the pipe buffer (~64KB). Flush, then exit. */
function emit(payload: unknown, code: number): never {
  process.stdout.write(`${encodeZbLine(payload)}\n`, () => process.exit(code));
  // Keep the event loop alive until the write callback fires.
  setTimeout(() => process.exit(code), 10_000).unref();
  return undefined as never;
}

const [, , endpoint, rawBody, rawTimeout] = process.argv;
if (!endpoint) {
  emit({ ok: false, error: 'usage: zb <endpoint> [json] [timeoutMs]', code: 'USAGE' }, 2);
} else {
  let body = '{}';
  let bodyOk = true;
  if (rawBody) {
    try {
      JSON.parse(rawBody);
      body = rawBody;
    } catch {
      bodyOk = false;
      emit({ ok: false, error: 'body is not valid JSON', code: 'USAGE' }, 2);
    }
  }
  if (bodyOk) {
    const timeoutMs = Math.max(1000, Number(rawTimeout) || 70_000);
    const port = Number(process.env.ZB_PORT || ZB_DAEMON_PORT);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/${endpoint.replace(/^\/+/, '')}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            emit(JSON.parse(text), 0);
          } catch {
            emit({ ok: false, error: `daemon returned non-JSON (${res.statusCode}): ${text.slice(0, 200)}`, code: 'BAD_RESPONSE' }, 0);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => {
      const code = (err as any)?.code === 'ECONNREFUSED' ? 'DAEMON_DOWN' : 'DAEMON_ERROR';
      emit({ ok: false, error: `daemon unreachable: ${err.message}`, code }, 2);
    });
    req.end(body);
  }
}
