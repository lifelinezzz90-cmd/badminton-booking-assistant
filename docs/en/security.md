# Security model

Real local configuration, secrets, logs, generated configuration, browser sessions, tokens, and cookies are excluded from version control. CAS and SMTP secrets use Windows DPAPI and are bound to the creating user.

Mail and automatic payment are off by default. Common plaintext-secret keys are rejected. VPN shortcut discovery avoids user-specific absolute paths. Install and uninstall operations are scoped to `BadmintonBookingAssistant_*`.

Release checks cover syntax, resolver compatibility, PlanOnly non-mutation, README examples, full-history Gitleaks, and additional personal-data patterns. DPAPI does not protect against a process already running with the same Windows user privileges.
