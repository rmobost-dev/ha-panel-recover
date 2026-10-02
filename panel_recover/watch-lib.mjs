// The Panel Recover add-on's watch loop. It notices that the Shelly app restarted (its uptime went down, or the
// whole panel's did) and then runs the recovery, trying again at most twice if a run stops. It never decides on
// taps itself: that is all in lib/panel-recover.mjs. Everything it touches comes in as functions, for the tests.
export function createWatcher({
  readStatus, // () => Sys.GetStatus of the panel
  recover, // () => recoverPanel(...) result
  sleep,
  log,
  now = () => performance.now(), // a monotonic clock on this host, ms
  settleMs = 60000, // give a restarted Shelly app this long before touching it
  retryMs = 120000, // between runs that stopped
  attempts = 3,
  startupWindowSec = 900, // an add-on start this soon after a Shelly app start (a power cut) counts as a restart
  slackSec = 30, // how far an uptime may lag the time that passed between two readings (request latency)
  maxLockWaitSec = 900, // the longest wait for another run's lock (recoverPanel reports at most a lease and a minute)
}) {
  const startedAt = now(); // the window above runs from here: a panel that answers only later is measured from then
  let last = null; // { app, up, at }: the uptimes of the last reading, and when it was taken (now())
  let recovering = false; // from a restart seen (its settle wait included) or a run asked for, to the end of its runs
  let failing = 0; // readings in a row that failed: the first one is said, and the reading that ends them
  const describe = (r) => (r.reason ? `${r.result}: ${r.reason}` : r.result);

  async function recoverWithRetries(why, waitMs = 0) {
    recovering = true;
    try {
      log(waitMs ? `${why}: bringing the page back in ${Math.round(waitMs / 1000)} s` : `${why}: bringing the page back`);
      if (waitMs) await sleep(waitMs);
      return await tries();
    } finally {
      recovering = false;
    }
  }
  async function tries() {
    for (let i = 1; i <= attempts; i++) {
      const r = await recover();
      log(`run ${i}/${attempts}: ${describe(r)}`);
      if (r.result !== 'stopped') return r;
      if (i < attempts) {
        await sleep(retryMs);
      } else if (r.busyForSec > 0) {
        // the last try met another run's lock, which may be one left by a run that died: once more after it
        const waitSec = Math.min(r.busyForSec, maxLockWaitSec);
        log(`once more when that lock runs out, in ${waitSec} s`);
        await sleep((waitSec + 5) * 1000);
        const afterLock = await recover();
        log(`run after the lock: ${describe(afterLock)}`);
        if (afterLock.result !== 'stopped') return afterLock;
      }
    }
    log('giving up until the next restart');
    return null;
  }

  // An uptime that went down, or fell behind the time that passed since the last reading, means a restart; the
  // second test also catches one that happened while a run kept this loop busy for minutes.
  const restartedSince = (prev, cur) => {
    const passedSec = (cur.at - prev.at) / 1000;
    return [[cur.app, prev.app], [cur.up, prev.up]].some(([c, p]) => c < p || c + slackSec < p + passedSec);
  };

  // a panel that stays unreachable (a network drop) is said once, not at every poll
  const failed = (msg) => { if (failing++ === 0) log(msg); };

  async function check() {
    let st;
    try {
      st = await readStatus();
    } catch (e) {
      failed(`cannot read the panel: ${e.message}`);
      return;
    }
    // numbers only, not converted (Number(null), Number('') and Number(false) are 0: a restart)
    const cur = { app: st?.app_uptime, up: st?.uptime, at: now() };
    if (![cur.app, cur.up].every((v) => Number.isFinite(v) && v >= 0)) {
      failed('the panel answered without uptimes');
      return;
    }
    if (failing) log(`the panel answers again, after ${failing} failed reading${failing === 1 ? '' : 's'}`);
    failing = 0;
    const restarted = last !== null && restartedSince(last, cur);
    const recent = last === null && cur.app < startupWindowSec + (cur.at - startedAt) / 1000;
    last = cur;
    if (!restarted && !recent) return;
    const why = restarted ? `the Shelly app restarted ${cur.app} s ago` : `watching from ${cur.app} s after a Shelly app start`;
    await recoverWithRetries(why, Math.max(0, settleMs - cur.app * 1000));
  }

  return { check, recoverWithRetries, get recovering() { return recovering; } };
}
