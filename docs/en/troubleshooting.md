# Troubleshooting

Run `.\badminton.ps1 doctor` first. If Node or Chrome is missing, install it or configure the non-default location. If WebBridge fails, verify the executable, extension, and local port. If EasyConnect is not discovered, select its actual Start Menu `.lnk` through `config`.

DPAPI secrets must be read by the same Windows user that created them. Re-run `setup` after changing users. Use `.\badminton.ps1 status` to inspect scheduled runs. Interactive browser tasks normally require that user to remain logged in.

A failed first court is not final: the runner continues through court priority, fallback campus, and partial-duration candidates.
