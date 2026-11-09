#!/usr/bin/env python3
"""Inventory MedSync QA registry tags without modifying registry storage."""

import fcntl
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


QA_ROOT = Path("/srv/medsync-qa")
QA_REPO = "medsync/qa-backend"
QA_IMAGE = f"registry.hemia.cloud/{QA_REPO}@"
QA_TAGS = Path("/opt/hemia/registry/data/docker/registry/v2/repositories") / QA_REPO / "_manifests/tags"
CI_TAG = re.compile(r"qa-[0-9a-f]{40}-[0-9]+-[0-9]+")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def report(tags_dir, history_file, now):
    history = history_file.read_text().splitlines()
    if not history or any(not ref.startswith(QA_IMAGE) or not DIGEST.fullmatch(ref.removeprefix(QA_IMAGE)) for ref in history):
        raise ValueError("Historial de rollback inválido o vacío")
    protected = {ref.removeprefix(QA_IMAGE) for ref in history}

    cutoff = now - timedelta(days=30)
    old_tags = []
    total_tags = 0
    for tag in sorted(tags_dir.iterdir()):
        if not tag.is_dir():
            continue
        total_tags += 1
        if not CI_TAG.fullmatch(tag.name):
            continue
        link = tag / "current/link"
        digest = link.read_text().strip()
        if not DIGEST.fullmatch(digest):
            raise ValueError(f"Digest inválido en {tag.name}")
        published_at = datetime.fromtimestamp(link.stat().st_mtime, timezone.utc)
        if published_at < cutoff and digest not in protected:
            old_tags.append(tag.name)

    print(f"{QA_REPO}: {total_tags} etiquetas, {len(protected)} digests protegidos por el historial del VPS.")
    print(f"Etiquetas de CI de más de 30 días fuera del historial: {len(old_tags)}.")
    for tag in old_tags:
        print(f"  Revisar {tag}")
    print("Solo informe. El borrado requiere preservar 10 versiones sanas verificadas y aislar la recolección de capas.")


if __name__ == "__main__":
    with (QA_ROOT / "ci.lock").open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        report(QA_TAGS, QA_ROOT / "state/images", datetime.now(timezone.utc))
