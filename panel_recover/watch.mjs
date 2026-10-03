// Entry point of the Panel Recover add-on (DOCS.md): reads the add-on options and watches the panel. Every
// `poll_seconds` it reads the panel's uptimes; after a Shelly app restart it runs the screenshot-checked recovery
// (lib/panel-recover.mjs). "recover" on stdin (the hassio.app_stdin action) runs one now. Exit 1 on unusable options.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { recoverPanel, get } from './lib/panel-recover.mjs';
import { createWatcher } from './watch-lib.mjs';
import { createDebugLog } from './debug-log.mjs';

// UTC, and said so: the Supervisor passes the host's TZ, but Alpine's Node has no ICU data for it (only the small
// English set) and would show UTC as if it were local time
const stamp = (d = new Date()) => `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const log = (msg) => console.log(`${stamp()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`panel_recover: ${msg}`); process.exit(1); };

let options;
try {
  options = JSON.parse(readFileSync(process.env.PANEL_RECOVER_OPTIONS || '/data/options.json', 'utf8'));
} catch (e) {
  fail(`options: cannot read them: ${e.message}`);
}
if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options: not an object');
const host = String(options.host ?? '');
const m = /^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/.exec(host);
if (!m || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) fail('host: a name or address, with an optional :port');
const seconds = (name, fallback) => {
  const v = options[name] ?? fallback;
  if (!Number.isInteger(v) || v < 10 || v > 600) fail(`${name}: a whole number of seconds, 10-600`);
  return v * 1000;
};
const pollMs = seconds('poll_seconds', 30);
const settleMs = seconds('settle_seconds', 60);
const debugOn = options.debug_log ?? false;
if (typeof debugOn !== 'boolean') fail('debug_log: true or false');

// what the panel sends reaches the log only as these words: a parse error would quote its body
const readStatus = async () => {
  const body = await get(host, '/rpc/Sys.GetStatus', { timeoutMs: 10000 });
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Sys.GetStatus did not answer with JSON');
  }
};
// the panel lock's owner: this process's own, so that two add-on instances on one panel (a restored backup on a
// second machine, the repository added twice) keep apart like any two machines
const owner = `ha-addon-${randomBytes(4).toString('hex')}`;
// a stop (an update, a restart) interrupts the run under way, which then taps nothing more and releases the lock
const interrupt = new AbortController();
let running = null; // the run under way, if any
const recover = () => {
  running = recoverPanel({ host, owner, signal: interrupt.signal, log: (msg) => log(`  ${msg}`) });
  return running.finally(() => { running = null; });
};
const watcher = createWatcher({ readStatus, recover, sleep, log, settleMs });
// the panel's own debug log, when asked for (DOCS.md): its last lines are shown when its stream ends, which a
// Shelly app restart does
const debugLog = debugOn && typeof WebSocket === 'function' ? createDebugLog({ url: `ws://${host}/debug/log`, log }) : null;

// one thing at a time: a check, or a run asked for on stdin
let queue = Promise.resolve();
const serial = (fn) => {
  queue = queue.then(fn).catch((e) => log(`error: ${e.message}`));
  return queue;
};

let asked = false; // a run asked for on stdin is waiting or under way: another ask joins it
createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim().replace(/^"(.*)"$/, '$1'); // hassio.app_stdin sends its input as a JSON string
  if (cmd === 'recover') {
    if (asked) return log('a run asked for is already waiting or under way');
    asked = true;
    if (watcher.recovering) log('the ask waits for the run under way to end');
    serial(() => watcher.recoverWithRetries('asked from Home Assistant').finally(() => { asked = false; }));
  } else if (cmd) {
    log('unknown command (send "recover")');
  }
});
// s6 gives the process 3 s after SIGTERM: the run under way gets 2.5 s of it to release the panel lock
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    debugLog?.stop();
    interrupt.abort();
    await Promise.race([running, sleep(2500)]);
    process.exit(0);
  });
}

log(`watching ${host} every ${pollMs / 1000} s`);
if (debugOn && !debugLog) log('debug log: this Node has no WebSocket, so the panel\'s debug log is not kept');
debugLog?.start();
for (;;) {
  await serial(() => watcher.check());
  await sleep(pollMs);
}
