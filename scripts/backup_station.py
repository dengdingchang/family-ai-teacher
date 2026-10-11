"""Private, allowlisted station backup. Never removes previous backups."""
import argparse
import hashlib
import json
import os
import re
import tarfile
from datetime import datetime, timezone
from pathlib import Path

FILES = ("child_profile.json", "session_history.jsonl", "learning_events.jsonl",
         "memories.json", "skill_graph.json", "activity_state.json", "parent_messages.json",
         "public_gateway_auth.json", "public_gateway_sessions.json",
         "parent_identity/portrait.jpg", "parent_identity/voice.f32",
         "parent_identity/active.json", "parent_identity/avatar.sha256")


def backup(root, destination):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    target = destination / ("teacher-" + stamp + ".tar.gz")
    partial = target.with_name(target.name + ".partial")
    paths = [root / "data" / name for name in FILES] + [root / ".env"]
    generated = root / "runtime/generated-media"
    if generated.is_dir():
        paths.extend(p for p in generated.iterdir() if re.fullmatch(r"[0-9a-f]{24}\.png(?:\.json)?", p.name))
    manifest = {}
    # Each file is read once; archive uses that exact byte snapshot.
    import io
    with tarfile.open(partial, "x:gz") as archive:
        os.chmod(partial, 0o600)
        for path in paths:
            if path.is_symlink():
                raise ValueError("Symlinks are not backup sources")
            if not path.is_file():
                continue
            data = path.read_bytes()
            relative = path.relative_to(root).as_posix()
            info = tarfile.TarInfo(relative)
            info.size, info.mode = len(data), 0o600
            archive.addfile(info, io.BytesIO(data))
            manifest[relative] = hashlib.sha256(data).hexdigest()
        data = json.dumps(manifest, sort_keys=True).encode()
        info = tarfile.TarInfo("SHA256.json")
        info.size, info.mode = len(data), 0o600
        archive.addfile(info, io.BytesIO(data))
    with tarfile.open(partial) as archive:
        for name, digest in manifest.items():
            assert hashlib.sha256(archive.extractfile(name).read()).hexdigest() == digest
    for name, digest in manifest.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError("Source changed during backup; retry while writes are paused")
    partial.replace(target)
    print("PASS backup verified files=" + str(len(manifest)))
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    backup(args.root, args.destination)
