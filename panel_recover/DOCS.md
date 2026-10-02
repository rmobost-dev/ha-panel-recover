# Panel Recover

The Shelly Wall Display's built-in Home Assistant page goes black after the Shelly app restarts (a button press
can restart it, so can a reboot or a power cut). Clearing the WebView cache in the panel's own settings brings
it back. This add-on does that by itself.

## What it does

- Every `poll_seconds` it reads the panel's uptimes (`/rpc/Sys.GetStatus`). When the Shelly app's uptime goes
  down (or the panel's), the app restarted.
- It waits until the app has run for `settle_seconds`, then runs the recovery: the bottom strip → settings →
  Сеть → Home Assistant → «Очистить кэш…» → «Да» → «Сохранять» → the HA tab.
- Before every tap a fresh screenshot must show the screen that tap belongs to: the settings pages and the
  confirmation dialog down to the pixels of their titles and of the label under the tap, the black page and the
  Shelly bar by their colours. Anything else (another screen, a dialog it did not open, a different model or
  firmware build) stops the run and taps nothing more. A live page is never tapped. A panel with an RPC password
  is not touched at all: the add-on cannot even read its uptimes then, and says so in its log.
- A run that stops is tried again twice, two minutes apart. Then it waits for the next restart.
- When the Shelly app started less than 15 minutes before the add-on did, or while the add-on could not reach
  the panel yet (both came back from a power cut, the panel later), it runs once.
- The panel holds a lock while a run works (the `panel_recover_lock` key in its KVS, renewed while the run
  works, deleted at its end). A run from another machine, or another instance of this add-on, meanwhile stops
  before touching the screen. When the add-on's last try meets such a lock, it tries once more after the lock
  runs out (a run that died leaves it for 5 minutes on the panel's clock, longer if that clock steps back).
- It reacts to restarts only: between them it takes no screenshots (a run switches the screen on to look at
  it). A page that went black for another reason needs a run by hand (below).

The live page is recognised by the colours of the dashboard it was calibrated with (its teal background over
most of the screen). With another dashboard the run cannot tell that the page is back: a black page still gets
its cache cleared, and then the run stops on a screen it does not know.

The taps were measured on a Shelly Wall Display XL (SAWD-3A1XE10EU2), firmware
`20260925-164731/2.8.0-324d2c10c-beta2`, Russian UI. On any other model or build it stops before the first tap
and says so in the log.

## Options

- `host` (required): the panel's address on your network, e.g. `192.0.2.10` or `name:port`. The add-on does
  not start until it is set.
- `poll_seconds` (10–600): how often the uptimes are read.
- `settle_seconds` (10–600): how long the restarted Shelly app runs before the recovery starts.

## A run by hand

Call the `hassio.app_stdin` action with `input: recover` and this add-on's slug as `app` (in the URL of its
page, e.g. `xxxxxxxx_panel_recover`; the older `hassio.addon_stdin` takes `addon` instead). An ask while an asked
run is waiting or under way joins it; one during an automatic run waits for it to end, and the log says so. The
log shows the outcome: `already-live` (nothing tapped),
`shown` (the page was behind the settings), `came-back`, `recovered` (cache cleared), or `stopped` with a
reason.

When the add-on is stopped or updated in the middle of a run, the run stops tapping and releases the lock (a
panel too slow to answer within 2.5 s keeps it for up to 5 minutes on the panel's clock). Within
15 minutes of the Shelly app's start the restarted add-on runs again by itself; later than that, ask for a run by
hand.
Stopped between «Очистить кэш…» and «Да», it may leave that dialog open: every later run then stops on it until
it is closed on the panel (the log says so).

## Access

It talks to the panel's local RPC over HTTP and to nothing else: no Home Assistant API, no host network, no
open ports.
