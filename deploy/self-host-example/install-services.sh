#!/usr/bin/env bash
# Install only; public cutover is a separate single-primary operation.
set -euo pipefail
project_root="/home/selfhost/workspaces/Personal Project/family-ai-teacher"
root="$project_root/app-live"
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ "$HOME" == /home/selfhost ]] || { echo 'Run as the existing selfhost user'; exit 1; }
[[ -f "$root/.env" && -x "$project_root/runtime/teacher-app/bin/python" ]] || exit 1
umask 077
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
backup="$project_root/backups/units-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup" "$HOME/.config/systemd/user"
for unit in family-teacher-app.service family-teacher-gateway.service family-ai-tts.service family-ai-soulx.service family-teacher-backup.service family-teacher-backup.timer; do
    dest="$HOME/.config/systemd/user/$unit"
    [[ ! -f "$dest" ]] || cp -p "$dest" "$backup/$unit"
    install -m 600 "$source_dir/$unit" "$dest"
done
systemctl --user daemon-reload
systemd-analyze --user verify "$HOME/.config/systemd/user/family-teacher-app.service" "$HOME/.config/systemd/user/family-teacher-gateway.service" "$HOME/.config/systemd/user/family-ai-tts.service" "$HOME/.config/systemd/user/family-ai-soulx.service" "$HOME/.config/systemd/user/family-teacher-backup.service"
echo 'PASS units installed; no connector was started or switched'
