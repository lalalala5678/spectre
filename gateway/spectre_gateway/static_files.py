"""Static file serving for the console SPA (traversal-proof)."""

import os

from . import config


def resolve(dist_rel):
    """Map URL path to file in DIST_DIR; None if unsafe/missing."""
    root = os.path.realpath(config.DIST_DIR)
    target = os.path.realpath(os.path.join(root, dist_rel.lstrip("/")))
    if target != root and not target.startswith(root + os.sep):
        return None
    return target if os.path.isfile(target) else None


def content_type(path):
    _, ext = os.path.splitext(path)
    return config.MIME_TYPES.get(ext, "application/octet-stream")


def cache_policy(dist_rel):
    """Hashed assets are immutable; entry documents revalidate."""
    if dist_rel.startswith("/assets/"):
        return "public, max-age=31536000, immutable"
    return "no-cache"
