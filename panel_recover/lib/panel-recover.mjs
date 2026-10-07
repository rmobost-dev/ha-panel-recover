// Brings the Shelly app's built-in Home Assistant page back after it went black (a Shelly app restart or a reboot):
// the bottom strip → settings → Сеть → Home Assistant → «Очистить кэш…» → «Да» → «Сохранять» → the HA tab
// («Сеть» is a row lower while the settings show the «Доступно обновление» notice on top).
// Safety rules, because a tap in the wrong place could switch off the panel's Wi-Fi or a light:
// - only on the device and firmware build the taps were measured on (CALIBRATION);
// - before every tap a fresh screenshot must show the screen that tap belongs to (panel-screens.mjs): the settings
//   pages and the dialog down to the exact pixels of their titles and of the label under the tap, the black page
//   and the bar by colour; anything else stops the run;
// - «Да» only on the dialog this run opened itself; a live page (the Glass Panel) is never tapped, and one hidden
//   behind the settings is looked at before anything is cleared;
// - after «Сохранять» the page may open by itself, so it is watched for a while before the HA tab is tapped.
// Everything read from the panel is bounded in size and time, and nothing it sends is echoed back raw.
import { request } from 'node:http';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { decodePng } from './png.mjs';
import { classifyScreen, TAPS, CALIBRATION } from './panel-screens.mjs';

// every wait and window is measured on a monotonic clock: a step of the wall clock (NTP after a power cut) must
// neither stretch nor cut one short, nor make a late lock write look in time
const clock = () => performance.now();
// the lock's windows count the wall clock too: on a Mac the monotonic clock stops while it sleeps, and a reading and a
// write a lid-close apart must not look a moment apart (a wall clock that steps only makes a window look longer)
const mark = () => ({ mono: clock(), wall: Date.now() });
const since = (m) => Math.max(clock() - m.mono, Date.now() - m.wall);
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024; // a real one is under 1 MB
const RPC_MAX_BYTES = 64 * 1024;
// One run at a time, whatever machine it runs on (this Mac, the HA add-on): the lock lives on the panel itself, in
// its KVS, as "<owner>@<until>" with `until` on the panel's own clock. A run renews it while it works and deletes it
// at the end, so one left by a run that died blocks the others for one lease at most.
export const PANEL_LOCK_KEY = 'panel_recover_lock';
export const PANEL_LOCK_LEASE_SEC = 300; // a run takes 1.5-3 min
const LOCK_CLOCK_SLACK_SEC = 60; // a lease this much longer than any run's may still be one: the panel's clock stepped back
const defaultOwner = () => `${hostname().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 28)}-${process.pid}`;
const parseLock = (v) => { const m = /^([A-Za-z0-9._-]{1,40})@(\d{1,12})$/.exec(String(v ?? '')); return m ? { owner: m[1], until: Number(m[2]) } : null; };
// a value from the panel: quoted, printable ASCII only (controls, bidi marks and the like escaped), and cut short
// after escaping, so a hostile value cannot push the rest of a stop reason out of the 400 characters the CLI prints
const shown = (v) => {
  const quoted = JSON.stringify(String(v ?? '').slice(0, 200)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return quoted.length > 80 ? `${quoted.slice(0, 76)}..."` : quoted;
};

// GET with an absolute deadline (not only an idle timeout) and a cap on the body size; an aborted `signal` gives the
// request up at once (an AbortError).
export function get(host, path, { timeoutMs, maxBytes = RPC_MAX_BYTES, signal }) {
  return new Promise((resolve, reject) => {
    const sep = host.lastIndexOf(':');
    const [hostname, port] = sep > 0 ? [host.slice(0, sep), host.slice(sep + 1)] : [host, '80'];
    const what = path.split('?')[0];
    // a fresh connection every time (agent: false): a tap must not go out on a kept-alive socket the panel dropped
    let answered = false;
    const req = request({ hostname, port, path, method: 'GET', timeout: timeoutMs, agent: false, signal }, (res) => {
      answered = true;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error(`${what} answered more than ${maxBytes} bytes`));
        else chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode === 200) return resolve(Buffer.concat(chunks));
        reject(Object.assign(new Error(`HTTP ${res.statusCode} on ${what}`), { status: res.statusCode }));
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`no complete answer within ${timeoutMs} ms on ${what}`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms on ${what}`)));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    // an Upgrade answer (101) is no answer at all, and a connection that closes before any answer must not leave
    // this promise open; once an answer has started, its own end or error settles it (a body that ends with the
    // connection fires this close before its end)
    req.on('upgrade', (res, socket) => { socket.destroy(); reject(new Error(`HTTP ${res.statusCode} (upgrade) on ${what}`)); });
    req.on('close', () => { clearTimeout(timer); if (!answered) reject(new Error(`the connection closed without an answer on ${what}`)); });
    req.end();
  });
}

export async function recoverPanel({
  host,
  pollMs = 1000,
  stepTimeoutMs = 30000,
  loadTimeoutMs = 60000,
  screenshotTimeoutMs = 25000,
  tapTimeoutMs = 15000,
  wakeSettleMs = 4000, // the page repaints about 3 s after the screen comes on
  blackGraceMs = 15000, // a page that has just come back to the front (screen on, HA tab) gets this long to repaint
  selfOpenWindowMs = 20000, // after «Сохранять» the panel is busy and may open the page by itself
  // who holds the panel lock while this run works: unique to the process, since a lock under this name counts as the
  // run's own (one left by a run of the same owner that died is taken over)
  owner = defaultOwner(),
  lockLeaseSec = PANEL_LOCK_LEASE_SEC, // whole seconds
  // the lock must be read and stored within lockWriteMaxMs (a round trip is ~50 ms), and is read back lockSettleMs
  // later: the guarantee needs lockSettleMs > lockWriteMaxMs, and lockSettleMs stays under a quarter of the lease (0
  // skips the read-back wait: tests only). A check of it before a tap counts as slow after lockWriteMaxMs.
  lockWriteMaxMs = 1000,
  lockSettleMs = 1500,
  signal, // aborted: the run stops at once, taps nothing more, releases the lock and ends as stopped, "interrupted"
  log = console.log,
}) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(owner)) throw new Error('owner: 1-40 of A-Z a-z 0-9 . _ -');
  if (!Number.isSafeInteger(lockLeaseSec) || lockLeaseSec < 1 || lockLeaseSec > PANEL_LOCK_LEASE_SEC) throw new Error(`lockLeaseSec: a whole number of seconds, 1-${PANEL_LOCK_LEASE_SEC}`);
  if (!(Number.isFinite(lockWriteMaxMs) && lockWriteMaxMs > 0)) throw new Error('lockWriteMaxMs: a number of milliseconds above 0');
  if (!(Number.isFinite(lockSettleMs) && (lockSettleMs === 0 || (lockSettleMs > lockWriteMaxMs && lockSettleMs < lockLeaseSec * 250)))) {
    throw new Error('lockSettleMs: more milliseconds than lockWriteMaxMs and under a quarter of the lease (0 only in tests)');
  }
  // once `signal` is aborted every wait ends at once with an AbortError, so does every request (whatever catches the
  // request's error meets it at the next sleep)
  const sleep = (ms) => delay(ms, undefined, { signal });
  const shot = async (timeoutMs) => classifyScreen(decodePng(await get(host, '/screenshot', { timeoutMs, maxBytes: SCREENSHOT_MAX_BYTES, signal }), { width: 1280, height: 800 }));
  // Looks until the screen is `wanted` (a list, or a test on the screen name) or the time is up; with `stable`,
  // the same screen must be seen twice in a row. An answer that asks for a password is final.
  const minAttemptMs = Math.min(250, screenshotTimeoutMs); // less than this left: a request could not finish
  const look = async (timeoutMs, wanted, { stable = false, seed = null } = {}) => {
    const deadline = clock() + timeoutMs;
    const fits = typeof wanted === 'function' ? wanted : (x) => wanted.includes(x);
    let lastSeen = null; // the last screen actually read: what a stop reason reports (else the caller's `seed`)
    let error = null; // why reading failed, when nothing better is known
    let previous = null;
    for (let attempts = 0; ; attempts++) {
      const left = deadline - clock();
      if (left <= 0 || (attempts > 0 && left < minAttemptMs)) break;
      await keepLock();
      if (attempts > 0 && deadline - clock() < minAttemptMs) break; // the renewal took the time left
      const budget = Math.min(screenshotTimeoutMs, Math.max(1, deadline - clock()));
      try {
        const screen = await shot(budget);
        lastSeen = screen;
        error = null;
        // two equal readings of a screen that is not the dialog: a «Очистить кэш…» dialog this run opened is gone; the
        // dialog seen before «Да» (it may come late) is this run's again
        if (screen === previous && [...SETTINGS, 'black', 'bar', 'live'].includes(screen)) dialogOpened = false;
        if (screen === 'clear-dialog' && clearPending) dialogOpened = true;
        if (fits(screen) && (!stable || screen === previous)) return { screen, ok: true };
        previous = screen;
      } catch (e) {
        // an attempt cut short by the step's own deadline says less than what was seen or failed before it
        if (!(budget < screenshotTimeoutMs && (lastSeen !== null || error))) error = e;
        previous = null;
        if ([401, 403, 404].includes(e.status)) return { screen: null, error: e, ok: false };
      }
      await sleep(pollMs);
    }
    return { screen: lastSeen ?? seed, error, ok: false };
  };
  const anyScreen = () => true;
  // `sig` null: a request that must go out even after an abort (the lock's release)
  const call = (method, timeoutMs = tapTimeoutMs, sig = signal) => get(host, `/rpc/${method}`, { timeoutMs, maxBytes: RPC_MAX_BYTES, signal: sig ?? undefined });
  const rpcJson = async (method, timeoutMs = 10000, sig = signal) => {
    try {
      return JSON.parse((await call(method, timeoutMs, sig)).toString('utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${method.split('?')[0]} did not answer with JSON`);
      throw e;
    }
  };

  // --- the panel lock ---
  const CLEAR = `if no run is working on the panel, clear it: http://${host}/rpc/KVS.Delete?key=${PANEL_LOCK_KEY}`;
  let lockWritten = false; // from the first write on, the lock is released at the end, if it is still ours
  let leaseWritten = null; // mark() of the last write of the lease: it is renewed once half of it has gone
  // the panel's clock (Sys.GetStatus unixtime), on which every run counts its lease; a panel that has just booted
  // may not have it yet
  const panelNow = async () => {
    const t = (await rpcJson('Sys.GetStatus'))?.unixtime;
    if (!Number.isSafeInteger(t) || t < 1600000000 || t >= 1e11) throw new Error(`the panel's clock is not set (Sys.GetStatus unixtime ${t == null ? 'none' : shown(t)}): try again in a minute`);
    return t;
  };
  // null when free, else its owner and the end of its lease; a value in any other form stops the run (a run of
  // another version may be holding the panel)
  const readLock = async (sig = signal, timeoutMs = 5000) => {
    const r = await rpcJson(`KVS.Get?key=${PANEL_LOCK_KEY}`, timeoutMs, sig);
    if (r?.code === -103) return null; // "Key not found"
    if (r?.code !== undefined) throw new Error(`KVS.Get failed (code ${shown(r.code)})`);
    const lock = parseLock(r?.value);
    if (!lock) throw Object.assign(new Error(`the panel lock holds ${shown(r?.value)}, which this version does not know: ${CLEAR}`), { code: 'ELOCKFORM' });
    return lock;
  };
  // `from`: the mark taken before the reading that `now` came after, so the lease is dated here no later than on the
  // panel, however long the write takes
  const writeLock = async (now, from) => {
    lockWritten = true;
    const r = await rpcJson(`KVS.Set?key=${PANEL_LOCK_KEY}&value=${encodeURIComponent(`${owner}@${now + lockLeaseSec}`)}`);
    if (r?.code !== undefined) throw new Error(`KVS.Set failed (code ${shown(r.code)})`);
    leaseWritten = from;
  };
  // Fischer's timed lock, as this KVS has no compare-and-swap known to work: the lock is stored within lockWriteMaxMs
  // of the reading that found it free, or the run gives up; then the run waits lockSettleMs, longer than any write
  // that counts may take, and reads it again. Of runs that found it free at about the same moment only the last
  // writer finds its own name there. A late write that slips through anyway is caught before the next tap.
  const takeLock = async () => {
    const readStarted = mark();
    const cur = await readLock();
    // the clock after the lock: every lease written before that reading counts from a time no later than this
    const now = await panelNow();
    const left = cur ? cur.until - now : 0;
    // a lease far longer than any run's (PANEL_LOCK_LEASE_SEC) can only come from a wrong clock: it counts as run out
    if (cur && cur.owner !== owner && left > 0 && left <= PANEL_LOCK_LEASE_SEC + LOCK_CLOCK_SLACK_SEC) {
      return { ...stopped(`another run is working on the panel (${shown(cur.owner)}) for up to ${left} s more: try again later (${CLEAR})`), busyForSec: left };
    }
    const tooSlow = () => stopped(`the panel took more than ${lockWriteMaxMs} ms to read and store the lock, so this run cannot be sure it is the only one: try again`);
    // an answer already too late is not followed by a write: it could overwrite a lock another run read free meanwhile
    if (since(readStarted) > lockWriteMaxMs) return tooSlow();
    await writeLock(now, readStarted);
    if (since(readStarted) > lockWriteMaxMs) return tooSlow();
    await sleep(lockSettleMs);
    const back = await readLock();
    if (!back) return stopped('the panel lock was cleared just after this run wrote it: try again');
    if (back.owner !== owner) return stopped('another run took the panel at the same moment: try again later');
    return null;
  };
  const lost = (cur) => new Error(`${cur ? `another run (${shown(cur.owner)}) took the panel lock` : 'the panel lock was cleared'} while this run worked: stopped before the next tap`);
  // right before every tap (and before the screen is switched on): the lock must still be ours. Only an answer that
  // says otherwise stops the run (a lock taken over, cleared by hand, or in a form this version does not know); a
  // reading that fails is tried twice more. Whether the check took longer than lockWriteMaxMs comes back: the screen
  // the tap was decided on may have gone meanwhile.
  const holdLock = async () => {
    const started = mark();
    for (let attempt = 1; ; attempt++) {
      let cur;
      try {
        cur = await readLock();
      } catch (e) {
        if (e.code === 'ELOCKFORM' || signal?.aborted || attempt >= 3) throw e;
        await sleep(pollMs);
        continue;
      }
      if (cur?.owner !== owner) throw lost(cur);
      // slow (a Mac that slept counts), or the lease nearly out: look again first, which renews it on the way
      return since(started) > lockWriteMaxMs || since(leaseWritten) > lockLeaseSec * 750;
    }
  };
  // while the run looks at the screen, never between a screenshot and its tap: once half the lease has gone it is
  // renewed, its reading and the clock read within lockWriteMaxMs. A reading that fails or comes too late writes
  // nothing and is tried again at the next look, until only a quarter of the lease is left: then the run stops, as
  // another run could soon take the lock over.
  const keepLock = async () => {
    if (!leaseWritten || since(leaseWritten) < lockLeaseSec * 500) return;
    const late = () => since(leaseWritten) > lockLeaseSec * 750;
    const giveUp = (why) => new Error(`the panel did not let this run renew its lock in time (${why}), so it cannot be sure it is still the only one`);
    const readStarted = mark();
    let cur;
    let now;
    try {
      cur = await readLock();
      if (cur?.owner === owner) now = await panelNow();
    } catch (e) {
      if (e.code === 'ELOCKFORM' || signal?.aborted) throw e;
      if (late()) throw giveUp(e.message);
      return;
    }
    if (cur?.owner !== owner) throw lost(cur);
    if (since(readStarted) > lockWriteMaxMs) {
      if (late()) throw giveUp(`its answers took more than ${lockWriteMaxMs} ms`);
      return;
    }
    // A lease with time left on the panel's clock is just written again: no other run can have found it free while
    // it lasted, so a write that lands late is harmless as long as it lands before the lease it renewed ran out (a Mac
    // that slept with the request in flight can make it land after). One that has run out, or one longer than this
    // run's own (the panel's clock stepped back: other runs count it as a wrong clock, so as free), may have been read
    // free by another run meanwhile: it is taken again the way it was taken first, written in time and read back
    // after the settle wait.
    const left = cur.until - now;
    const retake = left <= Math.ceil((2 * lockWriteMaxMs) / 1000) + 1 || left > lockLeaseSec;
    await writeLock(now, readStarted);
    if (!retake) {
      if (since(readStarted) > (left - 1) * 1000 - lockWriteMaxMs) {
        throw new Error('the renewal of the lock landed too late, after the lease it renewed may have run out, so this run cannot be sure it is still the only one');
      }
      return;
    }
    if (since(readStarted) > lockWriteMaxMs) throw new Error(`the panel took more than ${lockWriteMaxMs} ms to take the lock again, so this run cannot be sure it is still the only one`);
    await sleep(lockSettleMs);
    const back = await readLock();
    if (back?.owner !== owner) throw lost(back);
  };
  // at the end of every run that wrote the lock, an interrupted one included: deleted only while it is ours; a
  // release that fails is said, and the lease runs out by itself
  const releaseLock = async () => {
    try {
      if ((await readLock(null))?.owner !== owner) return;
      const r = await rpcJson(`KVS.Delete?key=${PANEL_LOCK_KEY}`, 5000, null);
      if (r?.code !== undefined && r.code !== -103) throw new Error(`KVS.Delete failed (code ${shown(r.code)})`);
    } catch (e) {
      // a value in another form is not this run's to clear (the next run reports it); anything else may leave ours
      if (e.code !== 'ELOCKFORM') log(`could not release the panel lock: ${e.message}; it runs out by itself within ${lockLeaseSec} s`);
    }
  };

  let tapped = false; // any tap
  let onlyHaTab = true; // every tap so far was the HA tab (bringing the page to the front)
  let cleared = false;
  let clearPending = false; // «Очистить кэш…» was tapped and «Да» not yet
  let dialogOpened = false; // and the dialog may be on the panel: a stop now may leave it open
  // `onScreen`: the screen the tap was decided on. After a slow lock check it is read again; a screen that changed
  // meanwhile is not tapped, the run decides again on what it shows now (a `rescreen`)
  const tap = async (name, onScreen) => {
    const [x, y] = TAPS[name];
    for (let round = 1; await holdLock(); round++) {
      if (round >= 3) throw new Error('the panel answered the lock check too slowly three times: stopped before the tap');
      const again = await look(stepTimeoutMs, anyScreen, { stable: true });
      if (!again.ok) throw new Error(`cannot read the panel's screen again before the tap: ${seen(again)}`);
      if (again.screen !== onScreen) throw Object.assign(new Error(`the screen changed before the tap: ${again.screen}`), { rescreen: again });
    }
    log(`tap ${name} (${x},${y})`);
    tapped = true;
    if (name !== 'haTab') onlyHaTab = false;
    if (name === 'clearCache') { clearPending = true; dialogOpened = true; } // from the moment the tap may reach the panel
    await call(`Ui.Tap?x=${x}&y=${y}`); // never retried: a tap that failed may still have happened
    if (name === 'yes') { clearPending = false; dialogOpened = false; }
  };
  const wake = async () => {
    await holdLock();
    log('switching the screen on');
    await call('Ui.Screen.Set?on=true');
    await sleep(wakeSettleMs);
    return look(stepTimeoutMs, (x) => x !== 'off', { stable: true });
  };
  // every later run stops on a dialog it did not open, so a stop that may leave this run's one open says so
  const stopped = (reason) => ({ result: 'stopped', reason: dialogOpened ? `${reason} (the «Очистить кэш…» dialog this run opened may still be on the panel: close it there)` : reason });
  const seen = (s) => (s.screen ?? `no screenshot (${s.error?.message ?? 'no answer'})`);
  // recovered: the cache was cleared and the page is live; shown: a live page was only brought to the front with the
  // HA tab; came-back: the page came back by itself during the run, before anything was cleared
  const done = () => ({ result: cleared ? 'recovered' : !tapped ? 'already-live' : onlyHaTab ? 'shown' : 'came-back' });
  const SETTINGS = ['settings', 'settings-update', 'network', 'ha-settings'];

  try {
    let info;
    try {
      info = JSON.parse((await call('Shelly.GetDeviceInfo', 10000)).toString('utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) return stopped('Shelly.GetDeviceInfo did not answer with JSON');
      throw e;
    }
    if (info?.auth_en) return stopped('the panel asks for a password (Shelly.GetDeviceInfo auth_en): this tool does not send one');
    if (info?.model !== CALIBRATION.model || info?.fw_id !== CALIBRATION.fwId) {
      return stopped(`the taps were measured on ${CALIBRATION.model} firmware ${CALIBRATION.fwId}; this panel is ${shown(info?.model)} ${shown(info?.fw_id)}: the taps must be re-calibrated for it first`);
    }
    const busy = await takeLock();
    if (busy) return busy;
    return await run();
  } catch (e) {
    return stopped(signal?.aborted ? 'interrupted' : e.message);
  } finally {
    if (lockWritten) await releaseLock();
  }

  async function run() {
    let s = await look(stepTimeoutMs, anyScreen, { stable: true });
    if (!s.ok) return stopped(`cannot read the panel's screen: ${seen(s)}`);
    let dialogIsOurs = false; // «Да» only on the dialog this run has just opened with «Очистить кэш…»
    let pageSeen = false; // the HA page itself (black, with the bar, or live) has been on the screen
    let blackConfirmed = false; // the page has stayed black for its whole repaint time
    let graceUntil = null; // the end of that repaint time, counted from the first black reading
    for (let step = 0; step < 32; step++) {
      log(`screen: ${s.screen}`);
      if (s.screen !== 'clear-dialog' && s.screen !== 'off') dialogIsOurs = false;
      if (['black', 'bar', 'live'].includes(s.screen)) pageSeen = true;
      try {
        let wanted;
        // settings in front before the page has been seen may hide a live page: bring the page to the front and
        // look at it before clearing anything; the settings still in front afterwards stop the run
        if (!pageSeen && SETTINGS.includes(s.screen)) {
          await tap('haTab', s.screen);
          s = await look(stepTimeoutMs, ['black', 'live', 'off'], { stable: true });
          if (!s.ok) return stopped(`expected the Home Assistant page after the HA tab, the panel shows ${seen(s)}`);
          continue;
        }
        switch (s.screen) {
          case 'off':
            s = await wake();
            if (!s.ok) return stopped(`the screen did not come on: ${seen(s)}`);
            blackConfirmed = false; // the page came back to the front: it gets its repaint time again
            graceUntil = null;
            continue;
          case 'live':
            return done();
          case 'black':
          case 'bar':
            if (!blackConfirmed) {
              // a page that has just come to the front (a screen someone switched on, the HA tab) can be black for a
              // few seconds while it repaints, with or without the bar over it: give it that time before clearing
              // anything. One window from the first black reading, whatever the bar does meanwhile.
              graceUntil ??= clock() + blackGraceMs;
              const other = await look(Math.max(0, graceUntil - clock()), (x) => x !== 'black' && x !== 'bar', { stable: true });
              if (other.ok) {
                // something else came to the front: live ends the run, off is woken, unknown stops; settings that
                // someone opened meanwhile hide the page again, so it is looked at again first
                s = other;
                if (SETTINGS.includes(s.screen)) { pageSeen = false; graceUntil = null; }
                continue;
              }
              // black for the whole window: go on from a fresh reading, not from one taken before the window ended
              s = await look(stepTimeoutMs, anyScreen, { stable: true });
              if (!s.ok) return stopped(`cannot read the panel's screen: ${seen(s)}`);
              if (s.screen === 'black' || s.screen === 'bar') blackConfirmed = true;
              else if (SETTINGS.includes(s.screen)) { pageSeen = false; graceUntil = null; }
              continue;
            }
            if (s.screen === 'black') { await tap('strip', s.screen); wanted = ['bar']; } else { await tap('gear', s.screen); wanted = SETTINGS; }
            break;
          case 'settings':
            await tap('network', s.screen); wanted = ['network'];
            break;
          case 'settings-update':
            await tap('networkBelowUpdate', s.screen); wanted = ['network'];
            break;
          case 'network':
            await tap('homeAssistant', s.screen); wanted = ['ha-settings'];
            break;
          case 'clear-dialog':
            if (!dialogIsOurs) return stopped('a confirmation dialog this run did not open is on the screen: close it on the panel and run again');
            await tap('yes', s.screen); dialogIsOurs = false; cleared = true; wanted = ['ha-settings'];
            break;
          case 'ha-settings':
            if (!cleared) { await tap('clearCache', s.screen); dialogIsOurs = true; wanted = ['clear-dialog']; break; }
            return await saveAndOpen();
          default:
            return stopped('unknown screen: nothing is tapped on a screen this tool does not recognise');
        }
        // the next tap is decided on two equal readings in a row (a stalled screenshot can show an old frame);
        // a screen gone off is woken, and a page that has come back by itself ends the run
        s = await look(stepTimeoutMs, [...wanted, 'off', 'live'], { stable: true });
        if (!s.ok) return stopped(`expected ${wanted.join(' or ')}, the panel shows ${seen(s)}`);
      } catch (e) {
        if (!e.rescreen) throw e;
        s = e.rescreen; // a tap not made: decide again on what the screen shows now
      }
    }
    return stopped('too many steps');
  }

  async function saveAndOpen() {
    await tap('save', 'ha-settings');
    const until = clock() + selfOpenWindowMs;
    while (clock() < until) {
      try { if ((await shot(Math.max(1, Math.min(screenshotTimeoutMs, until - clock())))) === 'live') return done(); } catch { /* busy: keep watching */ }
      await sleep(pollMs);
    }
    // the HA tab only on a fresh, stable reading of a settings screen (the spot is its HA button), right before the
    // tap; anything else is the page that opened by itself and is still loading: wait for it, tapping nothing. A
    // screen that changed during a slow lock check is decided on again here, in this phase, not by the steps before.
    let s = await look(stepTimeoutMs, anyScreen, { stable: true });
    for (let round = 1; ; round++) {
      if (s.ok && s.screen === 'off') s = await wake();
      if (!s.ok) return stopped(`expected the Home Assistant settings after «Сохранять», the panel shows ${seen(s)}`);
      if (s.screen === 'live') return done();
      if (!SETTINGS.includes(s.screen) || round > 3) break;
      try {
        await tap('haTab', s.screen);
        break;
      } catch (e) {
        if (!e.rescreen) throw e;
        s = e.rescreen;
      }
    }
    const end = await waitLive(loadTimeoutMs);
    if (end.ok) return done();
    return stopped(end.screen === 'black' ? 'the page is still black after clearing the cache' : `expected the live page, the panel shows ${seen(end)}`);
  }

  // waits for the live page, tapping nothing; a screen that goes off on the way is switched on again
  async function waitLive(timeoutMs) {
    const until = clock() + timeoutMs;
    let known = null;
    for (;;) {
      const r = await look(Math.max(0, until - clock()), ['live', 'off'], { seed: known });
      if (!r.ok || r.screen === 'live') return r;
      const w = await wake();
      if (!w.ok || w.screen === 'live') return w;
      known = w.screen;
      if (clock() >= until) return { ...w, ok: false };
    }
  }
}
