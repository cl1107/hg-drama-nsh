#!/usr/bin/env python3
"""Copy a local libmpv and its non-system dynamic dependencies into an app."""

import shutil
import stat
import subprocess
import sys
from pathlib import Path


def bundle(libmpv: Path, frameworks: Path) -> None:
    installed: dict[str, Path] = {}

    def stage(source: Path, name: str) -> None:
        source = source.resolve(strict=True)
        if name in installed:
            if installed[name] != source:
                raise ValueError(f"Conflicting copies of {name}")
            return
        installed[name] = source
        target = frameworks / name
        if target.exists():
            raise ValueError(f"Dynamic library already exists in the app: {name}")
        shutil.copy2(source, target)
        target.chmod(target.stat().st_mode | stat.S_IWUSR)

        dependencies = subprocess.check_output(["otool", "-L", source], text=True)
        arguments = ["install_name_tool", "-id", f"@loader_path/{name}"]
        for line in dependencies.splitlines()[2:]:
            reference = line.strip().split(" (compatibility version", 1)[0]
            if reference.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if reference.startswith(("@rpath/", "@loader_path/")):
                dependency = source.parent / reference.split("/", 1)[1]
            else:
                dependency = Path(reference)
                if not dependency.is_absolute():
                    raise ValueError(f"Unknown dynamic library reference: {reference}")
            stage(dependency, dependency.name)
            arguments.extend(["-change", reference, f"@loader_path/{dependency.name}"])
        subprocess.run([*arguments, target], check=True)

    frameworks.mkdir(parents=True, exist_ok=True)
    stage(libmpv, "libmpv.dylib")
    for name in installed:
        subprocess.run(["codesign", "--force", "--sign", "-", frameworks / name], check=True)


if __name__ == "__main__":
    bundle(Path(sys.argv[1]), Path(sys.argv[2]))
