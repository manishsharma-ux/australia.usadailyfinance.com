#!/usr/bin/env python3
"""Re-stamp the ?v= cache keys on local CSS and JS before a deploy.

Browsers hold on to css/style.css and js/custom.js for a long time. The only
reliable way to make them refetch is to change the URL, which is what the
"?v=..." on every <link> and <script> in the HTML is for. This script rewrites
those stamps from the file's own contents, so a file that did not change keeps
its URL and stays cached, and a file that did change gets a new one and is
refetched on the next visit.

    python3 bust-cache.py              # stamp every HTML file with content hashes
    python3 bust-cache.py --check      # show what would change, write nothing
    python3 bust-cache.py --version 7  # use one literal stamp for everything
    python3 bust-cache.py page.html    # only these files

IMPORTANT — this only works if the HTML itself is not cached. If the browser
serves index.html from its own cache it never sees the new stamps. Ship the
.htaccess next to this script, or set the equivalent on your server:

    Apache   .htaccess in this repo (already written)
    Nginx    location ~* \\.html$ { add_header Cache-Control "no-cache"; }
    Vercel   "headers" in vercel.json, source "/(.*).html"
    Cloudflare / any CDN: purge the cache after deploying, or the edge keeps
             serving the old HTML no matter what the origin says.

Not covered: images and fonts, which carry no ?v= stamp. They are referenced
from CSS rather than HTML. If you replace one in place, rename it (or add a
?v= by hand) or returning visitors will keep the old file.
"""

import argparse
import hashlib
import pathlib
import re
import sys

# src="..." or href="..." pointing at a local .css/.js, with or without a
# query string already on it. Absolute URLs are matched too so they can be
# skipped below — it is clearer than trying to exclude them in the pattern.
ASSET = re.compile(
    r'''(?P<lead>\b(?:src|href)\s*=\s*["'])'''
    r'''(?P<path>[^"'?\s>]+\.(?:css|js))'''
    r'''(?:\?(?P<query>[^"'#\s]*))?'''
    r'''(?P<frag>\#[^"'\s]*)?'''
    r'''(?P<tail>["'])''',
    re.IGNORECASE,
)

SKIP_PREFIXES = ('http://', 'https://', '//', 'data:')


def content_stamp(path: pathlib.Path) -> str:
    """Eight hex characters of the file's SHA-256 — short, and enough."""
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    return h[:8]


# js/diagnostics.js refuses to run the form when these three disagree — that is
# how a half-uploaded js/ folder is caught in the browser. Bumping one and
# forgetting the others produces the same red panel with nothing actually wrong,
# so the mismatch is worth catching here, before the files are shipped.
BUILD_STAMPS = {
    'js/custom.js':           re.compile(r"""SR_CUSTOM_BUILD\s*=\s*['"]([^'"]*)['"]"""),
    'js/maps-autocomplete.js': re.compile(r"""SR_MAPS_BUILD\s*=\s*['"]([^'"]*)['"]"""),
    'js/diagnostics.js':      re.compile(r"""EXPECTED_BUILD\s*=\s*['"]([^'"]*)['"]"""),
}


def check_build_stamps(root: pathlib.Path):
    """Return (ok, [lines to print]). Missing files are reported, not fatal."""
    found, lines = {}, []

    for rel, pattern in BUILD_STAMPS.items():
        path = root / rel
        if not path.is_file():
            lines.append('  !!  %s is missing' % rel)
            continue
        m = pattern.search(path.read_text(encoding='utf-8'))
        found[rel] = m.group(1) if m else None
        if m is None:
            lines.append('  !!  %s has no build stamp' % rel)

    stamps = set(v for v in found.values() if v)
    if len(stamps) <= 1 and not lines:
        only = stamps.pop() if stamps else '(none)'
        return True, ['build stamp                  %s' % only]

    lines.insert(0, 'BUILD STAMPS DISAGREE — the form will report a bad upload:')
    for rel, value in found.items():
        lines.append('  %-34s %s' % (rel, value or '(no stamp)'))
    lines.append('  Set all three to the same value before deploying.')
    return False, lines


def rewrite(html_path: pathlib.Path, root: pathlib.Path, fixed_version):
    """Return (new_text, [(asset, old_stamp, new_stamp), ...]) for one file."""
    text = html_path.read_text(encoding='utf-8')
    changes = []
    missing = []

    def sub(m):
        asset = m.group('path')
        if asset.startswith(SKIP_PREFIXES):
            return m.group(0)

        target = (html_path.parent / asset).resolve()
        if not target.is_file() or root not in target.parents and target != root:
            # Referenced file is not in this project — leave it exactly as is.
            if not target.is_file():
                missing.append(asset)
            return m.group(0)

        stamp = fixed_version or content_stamp(target)
        old = m.group('query') or ''
        old_v = re.sub(r'^.*?\bv=([^&]*).*$', r'\1', old) if 'v=' in old else ''
        if old_v == stamp:
            return m.group(0)

        changes.append((asset, old_v or '(none)', stamp))
        # Preserve any other query parameters that were there.
        others = [p for p in old.split('&') if p and not p.startswith('v=')]
        query = '&'.join(['v=' + stamp] + others)
        return (m.group('lead') + asset + '?' + query +
                (m.group('frag') or '') + m.group('tail'))

    return ASSET.sub(sub, text), changes, missing


def main():
    ap = argparse.ArgumentParser(
        description='Re-stamp ?v= cache keys on local CSS and JS.')
    ap.add_argument('files', nargs='*',
                    help='HTML files to rewrite (default: *.html here, '
                         'excluding *.backup.html)')
    ap.add_argument('--check', action='store_true',
                    help='report what would change and write nothing')
    ap.add_argument('--version', metavar='STAMP',
                    help='use this literal stamp for every asset instead of '
                         'a per-file content hash')
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent

    if args.files:
        targets = [pathlib.Path(f).resolve() for f in args.files]
    else:
        targets = sorted(p for p in root.glob('*.html')
                         if not p.name.endswith('.backup.html'))

    if not targets:
        print('No HTML files found.', file=sys.stderr)
        return 1

    total = 0
    for html in targets:
        if not html.is_file():
            print('skip  %s (not found)' % html.name, file=sys.stderr)
            continue

        new_text, changes, missing = rewrite(html, root, args.version)

        for asset in missing:
            print('  !!  %s -> %s does not exist' % (html.name, asset),
                  file=sys.stderr)

        if not changes:
            print('%-28s up to date' % html.name)
            continue

        print('%s' % html.name)
        for asset, old, new in changes:
            print('  %-34s %s -> %s' % (asset, old, new))
        total += len(changes)

        if not args.check:
            html.write_text(new_text, encoding='utf-8')

    stamps_ok, stamp_lines = check_build_stamps(root)
    print()
    for line in stamp_lines:
        print(line, file=sys.stderr if not stamps_ok else sys.stdout)

    if args.check:
        print('\n%d stamp(s) would change. Nothing written (--check).' % total)
        return 1 if (total or not stamps_ok) else 0

    print('\n%d stamp(s) updated.' % total)
    if total:
        print('Deploy the HTML together with the assets, and purge your CDN '
              'cache if you have one.')
    return 0 if stamps_ok else 1


if __name__ == '__main__':
    sys.exit(main())
