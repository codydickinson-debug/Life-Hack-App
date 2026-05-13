"""Vercel Python entry point.

Vercel's `@vercel/python` runtime auto-detects a WSGI `app` export and serves
every request that matches this catch-all under `/api/*` through it. The
underlying Flask app already defines its own `/api/<route>` paths, so no
prefix-stripping is needed.
"""
import os
import sys

# Make the stockanalyzer package importable.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_ROOT, "stockanalyzer"))

from app import app  # noqa: E402,F401  (Flask WSGI app exported for Vercel)
