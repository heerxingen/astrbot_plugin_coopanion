"""Build the two deployable archives: the AstrBot plugin and the Coopanion extension.

    python scripts/build_dist.py

Writes dist/astrbot_plugin_coopanion-<version>.zip and dist/cortico-world-cua-<version>.zip.
Both archives contain a single top-level folder, so unzipping puts a ready directory in place.
"""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"

PLUGIN_FILES = ["main.py", "client.py", "metadata.yaml", "_conf_schema.json", "requirements.txt", "LICENSE"]
PLUGIN_DIRS = ["views"]

EXT_FILES = ["package.json", "describe.json", "README.md", "CHANGELOG.md"]
EXT_DIRS = ["src", "scripts", "assets"]

INSTALL = """astrbot_plugin_coopanion {version}
================================

1) 放到 AstrBot 的插件目录：
     <AstrBot>/data/plugins/astrbot_plugin_coopanion/
   然后重启 AstrBot（或 Dashboard 里重载插件）。

2) 另一半在 Coopanion 上：把 cortico-world-cua-{version}.zip 解压，
   在 Coopanion 设置 -> 扩展 -> 手动安装 -> 本机目录，选解压出来的 cortico-world-cua 文件夹，
   重启进程，再到 World 总览启用 CUA。

3) 插件配置（Dashboard -> 插件 -> 本插件）：
     bridge_json   Coopanion 的 cua/bridge.json 路径（同机部署）
     或 base+token  AstrBot 在服务器上时用（见 docs/remote.md）
     umo           Coo 的消息投递到哪个会话
     coo_token     与 worlds.cua.chat.token 一致（可选，用 webhook 直连时）

完整说明：https://github.com/heerxingen/astrbot_plugin_coopanion
"""


def version() -> str:
    meta = (ROOT / "metadata.yaml").read_text(encoding="utf-8")
    return re.search(r"^version:\s*(\S+)", meta, re.M).group(1)


def add_file(zf: zipfile.ZipFile, path: Path, arc: str) -> None:
    zf.write(path, arc)


def build_plugin(ver: str) -> Path:
    out = DIST / f"astrbot_plugin_coopanion-{ver}.zip"
    top = "astrbot_plugin_coopanion"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in PLUGIN_FILES:
            src = ROOT / name
            if src.is_file():
                add_file(zf, src, f"{top}/{name}")
        for d in PLUGIN_DIRS:
            base = ROOT / d
            if base.is_dir():
                for p in sorted(base.rglob("*")):
                    if p.is_file():
                        add_file(zf, p, f"{top}/{p.relative_to(ROOT).as_posix()}")
        zf.writestr(f"{top}/INSTALL.txt", INSTALL.format(version=ver))
    return out


def build_extension(ver: str) -> Path:
    out = DIST / f"cortico-world-cua-{ver}.zip"
    src_root = ROOT / "coopanion-extension"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in EXT_FILES:
            src = src_root / name
            if src.is_file():
                add_file(zf, src, f"cortico-world-cua/{name}")
        for d in EXT_DIRS:
            base = src_root / d
            for p in sorted(base.rglob("*")):
                if p.is_file() and "__pycache__" not in p.parts:
                    add_file(zf, p, f"cortico-world-cua/{p.relative_to(src_root).as_posix()}")
        license_file = ROOT / "LICENSE"
        if license_file.is_file():
            add_file(zf, license_file, "cortico-world-cua/LICENSE")
    return out


def main() -> None:
    DIST.mkdir(exist_ok=True)
    for old in DIST.glob("*.zip"):
        old.unlink()
    ver = version()
    for path in (build_plugin(ver), build_extension(ver)):
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
        print(f"{path.name}  {path.stat().st_size / 1024:.0f} KiB  {len(names)} files")


if __name__ == "__main__":
    main()
