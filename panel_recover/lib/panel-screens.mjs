// What the Shelly Wall Display XL shows, told from a 1280x800 screenshot. Calibrated on real screenshots of one
// firmware build with the Russian UI (2026-10-01, the settings under the update notice 2026-10-07;
// tests/fixtures/make-panel-screens.mjs of the tooling repository):
// - colours at fixed points give the layout (rows and the gaps between them), and the bar's buttons are found on one
//   row of pixels (barButtons below: which of them is lit, and where they are);
// - the settings pages and the dialog must also show the exact pixels of their titles and of the label under the tap
//   (FINGERPRINTS: SHA-256 of those rectangles), so a moved row, another sub-page or another language reads as
//   "unknown". The one shift known is the settings list under the «Доступно обновление» notice: one row lower, with
//   the label under the tap checked there (the notice itself is not fingerprinted: its version number changes).
//   The black page and the bar (its buttons animate) are recognised by colour only.
// - the Shelly bar's five buttons move: they are centred in the space the status icons on its right leave (a few px
//   with the clock's digits, 32 px with the Matter icon: there on 2.8.0-beta2, not on 2.8.1). So they are found on
//   the screenshot (barButtons), and the gear and the HA tab are tapped where they are (BAR_TAPS).
// The tool also refuses any other device or firmware build (CALIBRATION).
import { createHash } from 'node:crypto';

// The device and firmware build the taps were measured on (Shelly.GetDeviceInfo model and fw_id).
// Re-calibrated on 2.8.1 on 2026-10-07: every title and label is the same pixels as on 2.8.0-beta2, only the bar moved.
export const CALIBRATION = { model: 'SAWD-3A1XE10EU2', fwId: '20261006-151932/2.8.1-ff4b93321' };

// Where each step taps (the same coordinates as in the README of the tooling repository, "Wall panel").
export const TAPS = {
  strip: [640, 797], // the thin strip left by the hidden bar: a tap brings the bar back (a swipe does not)
  network: [960, 353], // Настройки: «Сеть»
  networkBelowUpdate: [960, 419], // Настройки under the «Доступно обновление» notice row: «Сеть», one row lower
  homeAssistant: [960, 623], // Сеть: «Home Assistant»
  clearCache: [960, 327], // Home Assistant: «Очистить кэш…»
  yes: [813, 458], // the confirmation dialog: «Да»
  save: [1030, 708], // Home Assistant: «Сохранять»
};
// Taps on the bar: which of its five buttons (home, scenes, Home Assistant, settings, add), at its x on the
// screenshot the tap was decided on, and how low on it
export const BAR_TAPS = {
  gear: { button: 3, y: 770 }, // settings
  // the Home Assistant page; low on the button, so that on a page that opened meanwhile (the bar hidden) the tap
  // lands on the frame below it, not on a card
  haTab: { button: 2, y: 790 },
};
// [x, y] of a tap; `bar`: barButtons() of the screenshot it was decided on (needed for a tap on the bar)
export function tapPoint(name, bar) {
  if (TAPS[name]) return TAPS[name];
  const t = BAR_TAPS[name];
  if (!t) throw new Error(`no tap named ${name}`);
  if (!bar) throw new Error(`the ${name} tap needs the bar's buttons, found on the screenshot`);
  return [bar.x[t.button], t.y];
}

// [x0, y0, x1, y1] and the SHA-256 of its RGB bytes on the calibration screenshot of `screen`
export const FINGERPRINTS = {
  settingsTitle: { screen: 'settings', rect: [893, 17, 1028, 48], sha256: '0120fcfb6d590548ad8e44b903a999d4c18af9bf7799a69f5d608aedfdac2271' }, // «Настройки»
  settingsNetwork: { screen: 'settings', rect: [692, 343, 739, 364], sha256: '7b61094d2e4f5e83c1e98657f86183adfd4a68658ff8300d0dd163dbd9f5230c' }, // «Сеть»
  // Настройки with the «Доступно обновление» row on top (a newer firmware is out; screenshot of 2026-10-07): the same
  // title, and the same «Сеть» label one row (66 px) lower
  settingsUpdateTitle: { screen: 'settings-update', rect: [893, 17, 1028, 48], sha256: '0120fcfb6d590548ad8e44b903a999d4c18af9bf7799a69f5d608aedfdac2271' }, // «Настройки»
  settingsUpdateNetwork: { screen: 'settings-update', rect: [692, 409, 739, 430], sha256: '7b61094d2e4f5e83c1e98657f86183adfd4a68658ff8300d0dd163dbd9f5230c' }, // «Сеть»
  networkTitle: { screen: 'network', rect: [928, 17, 993, 44], sha256: '835770119126efd23000ad4d6b9e30d1806715fd5bca4c9ec459ef4296745aed' }, // «Сеть»
  networkHomeAssistant: { screen: 'network', rect: [693, 613, 823, 634], sha256: '28ae6560093409df57191b4735457f7289a878b3eca5a46e078b33e732038d0b' }, // «Home Assistant»
  haTitle: { screen: 'ha-settings', rect: [867, 17, 1054, 44], sha256: '9c2f282a2bef3759fd3365fb51814c8d302c611e323332e281dc03f2f959de7f' }, // «Home Assistant»
  haClearCache: { screen: 'ha-settings', rect: [660, 317, 792, 338], sha256: '57a42568efb896ffbc52f9f336adabddd07c82fe38eb3956ee8d31a3130913be' }, // «Очистить кэш…»
  haSave: { screen: 'ha-settings', rect: [960, 684, 1102, 732], sha256: 'dbcc8a245456a02344bb7dd4f45dc2dc9c6bda817bdd5719474a858291f24cd5' }, // «Сохранять»
  dialogTitle: { screen: 'clear-dialog', rect: [557, 314, 723, 339], sha256: '84e2c86431f7d0e0da1cc1313f0b85c7a2dd38c5d1b78555e3adefbe61c9984c' }, // «Очистить кэш...»
  dialogText: { screen: 'clear-dialog', rect: [305, 362, 640, 388], sha256: '8027e312d1a1484b89c90696c1883c82eb548a5c014b43470444fb839e0b7b73' }, // «Вы уверены, что хотите очистить кэш?»
  dialogYes: { screen: 'clear-dialog', rect: [799, 448, 828, 471], sha256: '627057b723d96c3d3328f3b55fabb7d413adff569ec64450f6343d6cca7fefe7' }, // «Да»
};

const BAR = [49, 51, 53];
const ROW = [63, 65, 70];
const BG = [12, 12, 13];
const BLUE = [21, 75, 183];
const DIALOG = [33, 36, 41];
const DIMMED_BAR = [13, 13, 14];

const near = (c, ref, tol = 8) => c.every((v, i) => Math.abs(v - ref[i]) <= tol);
const dark = (c) => Math.max(...c) <= 4;
// the Glass Panel's background and its glass cards are all teal
const teal = (c) => c[1] - c[0] >= 25 && c[2] - c[0] >= 20;

// the page area above the bar, sampled on a grid
function contentSamples(img) {
  const out = [];
  for (let y = 40; y <= 720; y += 80) for (let x = 40; x <= 1240; x += 100) out.push(img.rgb(x, y));
  return out;
}

// The row the bar's buttons are found on: above their icons, across the whole bar but the logo and the clock.
export const BAR_SCAN = [80, 752, 1180, 753];
const BUTTON_WIDTH = [44, 52]; // 48 px on this row
const BUTTON_GAP = [18, 30]; // 24 px of bar between two buttons
// The bar's five buttons on the screenshot: { active: the index of the lit one, x: their centres }, or null when the
// row is not exactly the bar, then five buttons of the right width and spacing with one of them lit, then the bar
// again (an anti-aliased pixel or two at a button's edge is allowed).
export function barButtons(img) {
  const bytes = img.region(...BAR_SCAN);
  const runs = [];
  for (let i = 0; i * 3 < bytes.length; i++) {
    const c = [bytes[3 * i], bytes[3 * i + 1], bytes[3 * i + 2]];
    const kind = near(c, BLUE) ? 'lit' : near(c, ROW) ? 'button' : near(c, BAR) ? 'bar' : 'edge';
    const last = runs[runs.length - 1];
    if (last?.kind === kind) last.end = i;
    else runs.push({ kind, start: i, end: i });
  }
  const parts = [];
  for (const r of runs) {
    if (r.kind !== 'edge') { parts.push(r); continue; }
    if (r.end - r.start + 1 > 2) return null;
  }
  if (parts.length !== 11) return null;
  const width = (r) => r.end - r.start + 1;
  const inside = (v, [lo, hi]) => v >= lo && v <= hi;
  const buttons = parts.filter((_, i) => i % 2 === 1);
  if (parts.some((r, i) => (i % 2 === 0) !== (r.kind === 'bar'))) return null;
  if (!buttons.every((r) => inside(width(r), BUTTON_WIDTH))) return null;
  if (!parts.slice(2, -2).filter((_, i) => i % 2 === 0).every((r) => inside(width(r), BUTTON_GAP))) return null;
  const lit = buttons.flatMap((r, i) => (r.kind === 'lit' ? [i] : []));
  if (lit.length !== 1) return null;
  return { active: lit[0], x: buttons.map((r) => Math.round(BAR_SCAN[0] + (r.start + r.end) / 2)) };
}

export const fingerprint = (img, rect) => createHash('sha256').update(img.region(...rect)).digest('hex');
const printed = (img, ...names) => names.every((n) => fingerprint(img, FINGERPRINTS[n].rect) === FINGERPRINTS[n].sha256);

// -> 'off' | 'black' | 'bar' | 'settings' | 'settings-update' | 'network' | 'ha-settings' | 'clear-dialog' | 'live' | 'unknown'
export const classifyScreen = (img) => readScreen(img).screen;

// -> { screen, bar }: bar is barButtons() on a screen that shows the bar (bar, the settings pages), else null
export function readScreen(img) {
  if (img.width !== 1280 || img.height !== 800) return { screen: 'unknown', bar: null };
  const at = (x, y) => img.rgb(x, y);
  const is = (x, y, ref) => near(at(x, y), ref);
  // the bar is read only where it is up: on the live page the row it is scanned on shows the dashboard
  const bar = is(300, 770, BAR) ? barButtons(img) : null;
  const screen = classify(img, at, is, bar);
  return { screen, bar: ['bar', 'settings', 'settings-update', 'network', 'ha-settings'].includes(screen) ? bar : null };
}

function classify(img, at, is, bar) {
  // the «Очистить кэш…» confirmation: its height, the blue «Да» band, and its own title and text
  if (is(720, 458, BLUE) && is(900, 458, BLUE) && is(640, 420, DIALOG) && is(720, 302, DIALOG) && is(720, 485, DIALOG)
    && dark(at(720, 296)) && dark(at(720, 495)) && is(300, 770, DIMMED_BAR)) {
    return printed(img, 'dialogTitle', 'dialogText', 'dialogYes') ? 'clear-dialog' : 'unknown';
  }
  // settings pages: the gear is the lit bar button (also where it is tapped, left of its icon), and the HA tab's spot
  // is on the HA button
  if (bar?.active === 3 && is(bar.x[3] - 18, 770, BLUE) && is(bar.x[2], 790, ROW)) {
    if (is(960, 327, ROW) && is(960, 294, BG) && is(960, 360, BG) && is(960, 600, BG) && is(1085, 690, BLUE) && is(1030, 690, BLUE)
      && printed(img, 'haTitle', 'haClearCache', 'haSave')) return 'ha-settings';
    if (is(960, 623, ROW) && is(960, 590, BG) && is(960, 656, BG) && is(960, 524, BG) && is(960, 314, BG) && is(1225, 89, BLUE)
      && printed(img, 'networkTitle', 'networkHomeAssistant')) return 'network';
    if (is(960, 353, ROW) && is(960, 320, BG) && is(960, 386, BG) && is(960, 89, ROW) && is(960, 122, BG) && is(960, 452, BG)
      && is(960, 485, BG) && is(1225, 89, ROW) && printed(img, 'settingsTitle', 'settingsNetwork')) return 'settings';
    // the same list one row lower, under a notice row on top: «Доступно обновление» stays there for as long as a newer
    // firmware is out and not installed (2026-10-07, 2.8.1)
    if (is(960, 419, ROW) && is(960, 386, BG) && is(960, 452, BG) && is(960, 485, ROW) && is(960, 89, ROW) && is(960, 122, BG)
      && is(960, 155, ROW) && is(960, 188, BG) && is(960, 518, BG) && is(960, 551, BG) && is(1225, 89, ROW)
      && printed(img, 'settingsUpdateTitle', 'settingsUpdateNetwork')) return 'settings-update';
    return 'unknown';
  }
  const content = contentSamples(img);
  const contentDark = content.every(dark);
  if (contentDark && dark(at(640, 797)) && dark(at(300, 770)) && dark(at(3, 400))) return 'off';
  if (contentDark && bar?.active === 2 && is(bar.x[2], 790, BLUE) && is(bar.x[3] - 18, 770, ROW) && is(640, 797, BAR)) return 'bar';
  if (contentDark && is(640, 797, BAR) && dark(at(300, 770)) && is(3, 400, BG)) return 'black';
  if (content.filter(teal).length / content.length >= 0.6 && is(640, 797, BAR) && is(594, 790, BG)) return 'live';
  return 'unknown';
}
