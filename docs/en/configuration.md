# Configuration

Precedence is internal defaults → `config/local.json` → one-run CLI overrides. The minimal file has four fields: `version`, `username`, `primaryCampus`, and `fallbackCampus`.

The `username` field is the unified-login/CAS account normally used by the target booking system. Never store its password in JSON. Enter it through `setup`, or replace it securely with `.\badminton.ps1 config -UpdatePassword`.

Add `courtPriority` only when changing the built-in order. A failed court does not stop later candidates. Start Menu VPN discovery is automatic. If it fails, run `.\badminton.ps1 config -SelectVpnShortcut` and select the EasyConnect `.lnk`; do not select an `.exe` or copy another user’s absolute path.

Mail is off by default. The CLI supports 163, QQ, and custom SMTP; authorization codes are stored with DPAPI, never in JSON. Automatic payment is off by default and requires `.\badminton.ps1 config -EnableAutoPayment` plus the exact confirmation phrase.

Advanced users may override documented defaults under `advanced`. Existing 46-field flat configurations remain supported without migration, including legacy payment semantics.
