"""Bundle the Xcode Pocket web editor for its native WKWebView."""
import argparse
from pathlib import Path
import re


def replace_once(text, source, target):
    if text.count(source) != 1:
        raise ValueError(f"Expected one copy of {source[:70]!r} in editor sources")
    return text.replace(source, target, 1)


def bundle(web):
    html = (web / "index.html").read_text(encoding="utf-8")
    core = (web / "core.mjs").read_text(encoding="utf-8")
    app = (web / "app.mjs").read_text(encoding="utf-8")
    css = (web / "styles.css").read_text(encoding="utf-8")
    imports = re.match(r'^import\s*\{([^}]+)\}\s*from\s*"\./core\.mjs";', app)
    if not imports:
        raise ValueError("Unexpected editor module imports")
    exports = re.findall(r'^export (?:class|const|function) (\w+)', core, re.M)
    required = [name.strip() for name in imports[1].split(",")]
    if not set(required).issubset(exports):
        raise ValueError("Editor imports unknown core symbols")
    core = re.sub(r'^export (?=(?:class|const|function) )', '', core, flags=re.M)
    app = app[imports.end():]
    app = replace_once(app, '''const url=URL.createObjectURL(new Blob([JSON.stringify(state.project,null,2)],{type:"application/json"}));
    const a=htmlEl("a");a.href=url;a.download="xcode-pocket-project.json";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);note("Projekt exportován.","success");''',
        '''window.webkit.messageHandlers.exportProject.postMessage(JSON.stringify(state.project,null,2));''')
    app = replace_once(app, '  if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});\n', '')
    js = "const {" + ", ".join(required) + "} = (() => {\n" + core + "\nreturn {" + ", ".join(required) + "};\n})();\n" + app
    if "</script" in js.lower() or "</style" in css.lower():
        raise ValueError("Unsafe inline HTML delimiter in editor asset")
    for link in ['<link rel="manifest" href="./manifest.webmanifest">', '<link rel="icon" href="./icon.svg" type="image/svg+xml">']:
        html = replace_once(html, link, "")
    html = replace_once(html, '<link rel="stylesheet" href="./styles.css">', "<style>\n" + css + "\n</style>")
    return replace_once(html, '<script type="module" src="./app.mjs"></script>', '<script type="module">\n' + js + '\n</script>')


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("web", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.write_text(bundle(args.web), encoding="utf-8")
