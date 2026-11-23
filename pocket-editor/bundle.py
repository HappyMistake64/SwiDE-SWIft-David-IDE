"""Inline the Pocket editor's local ES modules and styles for WKWebView file URLs."""
import argparse
from base64 import b64encode
from functools import lru_cache
from pathlib import Path
import re


# Keep the modules intact, including lexical scope and named exports. A data URL
# module has no directory, so its local imports must be resolved before encoding.
MODULE_IMPORT = re.compile(
    r"""^(?P<prefix>[ \t]*import\s+(?:(?:\{[^{}]*\}|\*\s+as\s+\w+|\w+)\s+from\s*)?)"""
    r"""(?P<quote>["'])(?P<path>[^"'\r\n]+)(?P=quote)""",
    re.MULTILINE,
)
MODULE_TAG = re.compile(r'<script type="module" src="([^"]+)"></script>')
STYLE_TAG = re.compile(r'<link rel="stylesheet" href="([^"]+)">')


def bundle(web):
    root = web.resolve()

    def resolve(folder, specifier):
        if not specifier.startswith("./") and not specifier.startswith("../"):
            raise ValueError(f"Expected a local editor asset, got {specifier!r}")
        path = (folder / specifier).resolve()
        if root not in path.parents:
            raise ValueError(f"Editor asset outside web directory: {specifier!r}")
        return path

    active = set()

    @lru_cache(maxsize=None)
    def module_url(path):
        if path in active:
            raise ValueError(f"Native bundle contains a cyclic import of {path.name}")
        active.add(path)
        try:
            def rewrite(match):
                child = resolve(path.parent, match["path"])
                return f'{match["prefix"]}"{module_url(child)}"'

            source = MODULE_IMPORT.sub(rewrite, path.read_text(encoding="utf-8"))
            encoded = b64encode(source.encode("utf-8")).decode("ascii")
            return "data:text/javascript;base64," + encoded
        finally:
            active.remove(path)

    def inline_style(match):
        css = resolve(root, match[1]).read_text(encoding="utf-8")
        if "</style" in css.lower():
            raise ValueError("Unsafe closing style delimiter in editor stylesheet")
        return "<style>\n" + css + "\n</style>"

    html = (root / "index.html").read_text(encoding="utf-8")
    html = re.sub(r'<link rel="(?:manifest|icon)"[^>]*>', '', html)
    html, styles = STYLE_TAG.subn(inline_style, html)
    html, modules = MODULE_TAG.subn(
        lambda match: '<script type="module" src="' + module_url(resolve(root, match[1])) + '"></script>',
        html,
    )
    if not styles or not modules:
        raise ValueError("Missing editor stylesheet or module entry point")
    return html


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("web", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(bundle(args.web), encoding="utf-8")
