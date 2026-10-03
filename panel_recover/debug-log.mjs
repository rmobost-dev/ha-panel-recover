// The panel's own debug log (ws://<panel>/debug/log, served by the Shelly app while the panel's debug websocket is
// on), kept for its last minutes. The stream ends when the Shelly app goes away (it serves the stream) or the
// network does: its last lines then go to the add-on's log, so a restart shows what the panel logged right before
// it. The routine lines of Sys.GetStatus polling (the add-on's own) are counted, not shown; what is shown is cleaned
// (secrets masked as far as they can be told, control characters replaced, long lines cut). Everything it touches
// comes in as functions, for the tests.

// the four routine lines a Sys.GetStatus call over HTTP leaves (the add-on's polling, every poll_seconds, and any other
// client's): noise that would crowd out everything else. Any other line about it (an error) is shown
const noise = (s) => s === '[WebSocket]: Request body processed as {}'
  || /^\[WebSocket\]: RPC plain HTTP method arrived from \S+: == GET \/rpc\/Sys\.GetStatus ==$/.test(s)
  || /^\[WebSocket\]: Will execute RPC method \[\d+\] Sys\.GetStatus with params \{\}$/.test(s)
  || (s.startsWith('[WebSocket]: Sending HTTP response to ') && s.includes('"app_uptime"') && !s.includes('"sys":'));

const MAX_RAW = 1048576; // a longer message is not parsed, only cut
const MAX_KEPT = 2000; // a line is cut to this when it comes (memory, and what masking it may cost)...
const MAX_TEXT = 300; // ...and to this when it is shown

// --- masking: best effort, for the forms a Shelly log line has (JSON, key=value, URLs, auth headers) ---
// a secret key: one of these words, alone or joined to other words by _ or - (wifi_pass, X-API-Key, token_v2,
// sta1_pass, password2), or ending a camelCase name (accessToken, clientSecret, apiKey). Whole words only, so that
// bypass, passive_scan or Compass stay readable
const WORD = String.raw`(?:tokens?|secrets?|passwords?|passwd|passphrase|passcode|pass|pwd|pw|pins?|psk|ha1|authorization|(?:api|private|secret|access|auth|client|master)[_-]?keys?|credentials?|cookies?)`;
const SNAKE_KEY = String.raw`_*(?:[a-z0-9]+[_-])*${WORD}\d*(?:[_-][a-z0-9]+)*`;
const CAMEL_KEY = String.raw`[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*?(?:Tokens?|Secrets?|Passwords?|Passwd|Passphrase|Passcode|Pass|Pwd|Pw|PW|Pins?|PIN|Psk|PSK|Authorization|Credentials?|Cookies?|(?:Api|Private|Access|Auth|Client|Master)Keys?)\d*`;
// its value: quoted (escapes, and a cut at a lone backslash, included), a list or an object (nested up to three
// levels, strings in it read as strings) up to its close, one that cannot be closed to the end of the line, or bare
// up to a separator (not from an escaped quote: that is a quoted value of JSON held in a string)
const QUOTED = String.raw`"(?:[^"\\]|\\[\s\S])*(?:"|$)`;
const NESTED = (o, c) => {
  const O = `\\${o}`, C = `\\${c}`, P = `[^${O}${C}"]|${QUOTED}`;
  return `${O}(?:${P}|${O}(?:${P}|${O}(?:${P})*${C})*${C})*(?:${C}|$)`;
};
const VALUE = String.raw`"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|${NESTED('[', ']')}|${NESTED('{', '}')}|[\[{][\s\S]*|(?:[^\s"'\\,;&}\]]|\\[^"\\])[^\s",;&}\]]*`;
// the lookahead first: a name of at most 64 characters followed by = or :, so that a long run of name-like words
// (psk-psk-psk-...) costs a glance, not a search through every way to split it
const keyed = (key, flags) => new RegExp(String.raw`(["']?)\b(?=[A-Za-z0-9_-]{1,64}["']?\s*[=:])(${key})(["']?)(\s*[=:]\s*)(${VALUE})`, flags);
const SNAKE_SECRET = keyed(SNAKE_KEY, 'gi');
const CAMEL_SECRET = keyed(CAMEL_KEY, 'g');
const DIGEST_RESPONSE = keyed('response', 'gi'); // only where a nonce says it is digest auth (else: an RPC answer)
const AUTH_HEADER = /\b(authorization|proxy-authorization|www-authenticate)(["']?\s*[:=]\s*["']?)(?:basic|bearer|digest|token)\s+[^"\n]*/gi;
const COOKIE_HEADER = /\b((?:set-)?cookie)(\s*:\s*)[^"\n]*/gi; // the header form; "cookie": is the keyed rule's
const BEARER = /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{8,}/gi;
// a scheme or a JWT starts where a run of their characters starts: one try per run, not one per character in it
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@?#]*:)[^\s/"?#]*@/gi; // up to the last @: a password may hold one
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g;

const masked = (s) => {
  const m = s.replace(JWT, '<jwt>').replace(USERINFO, '$1<hidden>@').replace(AUTH_HEADER, '$1$2<hidden>')
    .replace(COOKIE_HEADER, '$1$2<hidden>').replace(BEARER, '$1 <hidden>').replace(SNAKE_SECRET, '$1$2$3$4<hidden>').replace(CAMEL_SECRET, '$1$2$3$4<hidden>');
  return /nonce/i.test(m) ? m.replace(DIGEST_RESPONSE, '$1$2$3$4<hidden>') : m;
};
// %XX runs decoded (ASCII only where a run is not UTF-8), so that URL-encoded keys and values get masked too
const percentDecoded = (s) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.replace(/%([0-7][0-9A-Fa-f])/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
});

// a line from the panel as the add-on's log may show it: secrets masked as it came (an escaped quote inside a value
// still counts as inside it), then level by level with JSON held in a string unescaped (three levels at most), then
// the same again with %XX decoded (decoding first would split an encoded value at its %20 or %26); one line, no
// control or format characters (no terminal escapes, no bidi tricks), not endless
const levels = (s) => {
  let cur = masked(s);
  for (let level = 0; level < 3; level++) {
    const next = cur.replace(/\\(["\\/])/g, '$1');
    if (next === cur) break;
    cur = masked(next);
  }
  return cur;
};
export function cleanLine(text) {
  const once = levels(String(text));
  const decoded = percentDecoded(once);
  const flat = (decoded === once ? once : levels(decoded)).replace(/\r?\n/g, '\\n').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

const utcTime = (ms) => new Date(ms).toISOString().slice(11, 23);
// a copy of the start of a string: a plain slice would keep the whole message it was cut from alive
const kept = (s) => Buffer.from(s.slice(0, MAX_KEPT), 'utf8').toString('utf8');

export function createDebugLog({
  url, // ws://<panel>/debug/log
  log,
  open = (u) => new WebSocket(u), // a WHATWG WebSocket: onopen, onmessage, onclose, close()
  now = () => Date.now(),
  later = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
  keepMs = 300000, // what came in the 5 min before the stream's last message is kept
  maxLines = 1000,
  showLines = 60, // the last ones of them are shown when the stream ends
  retryMs = 10000, // the next try after a stream ended; doubled after each try that fails...
  maxRetryMs = 300000, // ...up to this
  missedAfterMs = 180000, // a stream that has not come back for this long after it ended is said once
}) {
  let socket = null; // the stream being opened or open
  let timer = null; // the next try, while one waits
  let stopped = false;
  let working = false; // the open stream has sent something
  let everWorked = false;
  let failingSince = null; // since when tries have failed (null: the last stream worked, or none was tried yet)
  let saidFailing = false; // that run of failures was said
  let delay = retryMs;
  // what the working stream sent: { recv, at, text } (text null for noise, which is only counted), when it came,
  // and the panel's own time
  let lines = [];
  let lastRecv = 0; // when the working stream last sent anything (its window ends there)

  const received = (data) => {
    const raw = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
    const recv = now();
    lastRecv = recv;
    let at = recv;
    let text = raw;
    if (raw.length <= MAX_RAW) {
      try {
        const m = JSON.parse(raw);
        if (m && typeof m.data === 'string') {
          text = m.data;
          if (Number.isFinite(m.ts) && m.ts > 0 && m.ts < 1e11) at = Math.round(m.ts * 1000);
        }
      } catch { /* not a log line: kept as text, at the time it came */ }
    }
    lines.push({ recv, at, text: noise(text) ? null : kept(text) });
    while (lines.length && (lines.length > maxLines || lines[0].recv < recv - keepMs)) lines.shift();
  };

  const ended = () => {
    const recent = lines.filter((l) => l.recv >= lastRecv - keepMs);
    lines = [];
    const shown = recent.filter((l) => l.text !== null).slice(-showLines);
    const polls = recent.filter((l) => l.text === null);
    const left = polls.length ? ` (${polls.length} polling line${polls.length === 1 ? '' : 's'} left out, the last at ${utcTime(polls.at(-1).at)})` : '';
    const what = "debug log: the panel's stream ended (the Shelly app went away, or the network)";
    if (!shown.length) return log(`${what}; nothing else came in its last ${Math.round(keepMs / 60000)} min${left}`);
    log(`${what}; its last ${shown.length} line${shown.length === 1 ? '' : 's'}${left}:`);
    for (const l of shown) log(`  | ${utcTime(l.at)} ${cleanLine(l.text)}`);
  };

  // a try that did not give a working stream: said once at the start, and once when a stream that worked has not
  // come back for missedAfterMs (an app restart takes well under that); tried again less and less often
  const failed = () => {
    failingSince ??= now();
    if (!saidFailing && !everWorked) {
      saidFailing = true;
      log(`debug log: cannot open ${url} (is the panel's debug websocket on?): trying again, less often while it fails`);
    } else if (!saidFailing && now() - failingSince >= missedAfterMs) {
      saidFailing = true;
      log(`debug log: the panel's stream has not come back for ${Math.round((now() - failingSince) / 60000)} min (is its debug websocket still on?): still trying`);
    }
    retry();
    delay = Math.min(delay * 2, maxRetryMs);
  };
  const retry = () => { if (!stopped) timer = later(connect, delay); };

  function connect() {
    timer = null;
    if (stopped) return;
    let s;
    try {
      s = open(url);
    } catch {
      return failed();
    }
    socket = s;
    try { s.binaryType = 'arraybuffer'; } catch { /* a socket without it sends text only */ }
    s.onopen = () => {};
    // a stream works once it sends something: the add-on's own polling makes the panel log at every poll
    s.onmessage = (ev) => {
      if (stopped || socket !== s) return;
      if (!working) {
        working = everWorked = true;
        failingSince = null;
        saidFailing = false;
        delay = retryMs;
        lines = [];
        log('debug log: connected');
      }
      received(ev.data);
    };
    s.onerror = () => {}; // the close that follows says what happened
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      if (stopped) return;
      if (!working) return failed();
      working = false;
      ended();
      failingSince = now();
      retry();
    };
  }

  return {
    start() { if (!socket && !timer && !stopped) connect(); },
    stop() {
      stopped = true;
      if (timer) cancel(timer);
      timer = null;
      const s = socket;
      socket = null;
      try { s?.close(); } catch { /* closing is all that is left to do */ }
    },
  };
}
