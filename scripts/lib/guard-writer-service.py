import json
import os
import pathlib
import plistlib
import sys


def main():
    action, kind, destination, candidate = sys.argv[1:]
    root = pathlib.Path(os.environ["HOME"]) / ".local/state/metafactory/cortex/writer-fence"
    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        return 1 if action == "retired" else 0
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("entries"), dict):
        raise ValueError("Unknown persistent writer manifest")
    retired = [route for entry in manifest["entries"].values() for route in entry["retiredEntries"]]
    if action == "retired":
        return 0 if any(route["definition"] == destination for route in retired) else 1
    if not (root / "launch").is_file():
        raise ValueError("Persistent writer launcher missing; resume explicit cutover")
    path = pathlib.Path(candidate)
    if kind == "plist":
        value = plistlib.loads(path.read_bytes())
        stack = value.get("EnvironmentVariables", {}).get("CORTEX_CHANNEL")
        if not stack or not any(entry["stack"] == stack for entry in manifest["entries"].values()):
            return 0
        args = value["ProgramArguments"]
        if args[0] != str(root / "launch"):
            value["ProgramArguments"] = [str(root / "launch"), stack] + args
        path.write_bytes(plistlib.dumps(value))
    elif pathlib.Path(destination).name == "cortex@.service":
        value = path.read_text()
        old = "ExecStart=%h/.local/bin/cortex "
        new = "ExecStart=%h/.local/state/metafactory/cortex/writer-fence/launch %i %h/.local/bin/cortex "
        if old not in value and new not in value:
            raise ValueError("Unknown managed service executable route")
        path.write_text(value.replace(old, new))
    return 0


try:
    sys.exit(main())
except Exception as error:
    print(f"cortex writer fence: {error}", file=sys.stderr)
    sys.exit(2)
