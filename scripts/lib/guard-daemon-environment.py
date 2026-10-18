import pathlib
import plistlib
import re
import shlex
import sys


def plist_keys(path):
    with path.open("rb") as source:
        env = plistlib.load(source).get("EnvironmentVariables", {})
    if not isinstance(env, dict):
        raise ValueError("Invalid environment dictionary")
    return set(env)


def systemd_keys(path):
    keys = set()
    section = ""
    text = path.read_text().replace("\\\n", " ")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            section = line
        if section != "[Service]" or "=" not in line:
            continue
        directive, value = line.split("=", 1)
        directive = directive.strip()
        if directive == "Environment":
            if not value.strip():
                keys.clear()
            for assignment in shlex.split(value):
                name, separator, _value = assignment.partition("=")
                if not separator:
                    raise ValueError("Invalid environment assignment")
                keys.add(name)
        elif directive in ("EnvironmentFile", "PassEnvironment", "UnsetEnvironment"):
            keys.add(directive)
    return keys


def main():
    kind, old_name, new_name = sys.argv[1:]
    old = pathlib.Path(old_name)
    if not old.exists():
        return 0
    try:
        reader = plist_keys if kind == "plist" else systemd_keys
        dropped = reader(old) - reader(pathlib.Path(new_name))
        if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) for key in dropped):
            raise ValueError("Invalid environment key")
    except Exception:
        print("cortex render: cannot verify existing daemon environment; refusing replacement", file=sys.stderr)
        return 1
    if dropped:
        print("cortex render: refusing to drop environment keys: " + ", ".join(sorted(dropped)), file=sys.stderr)
        print("Keep the existing service until these keys are migrated; store surface secrets with `arc secrets set cortex NAME` before removing their old entries.", file=sys.stderr)
        return 1
    return 0


sys.exit(main())
