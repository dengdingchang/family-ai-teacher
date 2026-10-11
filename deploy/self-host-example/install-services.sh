#!/usr/bin/env bash
# Install only; public cutover is a separate single-primary operation.
set -euo pipefail
root="/home/selfhost/family-ai-teacher/app-live"
[[ "$HOME" == /home/selfhost ]] || { echo 'Run as the existing selfhost user'; exit 1; }
[[ -f "$root/.env" && -x /home/selfhost/family-ai-teacher/runtime/teacher-app/bin/python ]] || exit 1
umask 077
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
backup="$HOME/family-ai-teacher/backups/units-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup" "$HOME/.config/systemd/user"
for unit in family-teacher-app.service family-teacher-gateway.service family-teacher-tunnel.service family-teacher-backup.service family-teacher-backup.timer; do
    dest="$HOME/.config/systemd/user/$unit"
    [[ ! -f "$dest" ]] || cp -p "$dest" "$backup/$unit"
    install -m 600 "$root/deploy/self-host/$unit" "$dest"
done
systemctl --user daemon-reload
systemd-analyze --user verify "$HOME/.config/systemd/user/family-teacher-app.service" "$HOME/.config/systemd/user/family-teacher-gateway.service"
echo 'PASS units installed; no connector was started or switched'
