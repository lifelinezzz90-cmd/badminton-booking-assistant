# Architecture

`badminton.ps1` is the public entrypoint. `scripts/config_resolver.mjs` produces one validated effective configuration from defaults, local configuration, and command overrides. PowerShell and Node consume the same result.

The scheduled chain has five roles: WebBridge prestart, VPN preconnect, preflight, booking, and postcheck. Booking decisions are isolated in `scripts/booking_logic.mjs`; runners orchestrate the browser and session. Project tasks use the `BadmintonBookingAssistant_*` namespace.

The optional dashboard is a loopback-only status tool. It generates previews through the same installer and cannot enable automatic payment.
