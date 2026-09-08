#!/usr/bin/env python3
"""SPECTRE auth gateway entrypoint (systemd target)."""

from spectre_gateway.handler import serve

if __name__ == "__main__":
    serve()
