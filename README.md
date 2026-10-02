# Panel Recover add-on

A Home Assistant add-on that brings the Shelly Wall Display's built-in Home Assistant page back when it is
black after the Shelly app restarted. Each tap is checked on a screenshot first. Details are in
[panel_recover/DOCS.md](panel_recover/DOCS.md).

To install it: Settings → Apps → App store → ⋮ → Repositories → add
`https://github.com/rmobost-dev/ha-panel-recover`, then install **Panel Recover** and set its `host` option
(older versions call them add-ons: Settings → Add-ons → Add-on store).

This repository is generated from a private one by `tools/publish-addon.sh`. Change the code there, not here.
