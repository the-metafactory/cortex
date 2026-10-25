import json
import pathlib
import plistlib
import re
import shlex
import sys


def plist_keys(path):
    with path.open("rb") as source:
        configuration = plistlib.load(source)
    env = configuration.get("EnvironmentVariables", {})
    if not isinstance(env, dict):
        raise ValueError("Invalid environment dictionary")
    return set(env), set(configuration)


def systemd_keys(path):
    keys = set()
    directives = set()
    section = ""
    text = path.read_text().replace("\\\n", " ")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            section = line
            continue
        if not section or "=" not in line:
            continue
        directive, value = line.split("=", 1)
        directive = directive.strip()
        directives.add(f"{section}.{directive}")
        if section != "[Service]":
            continue
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
    return keys, directives


def main():
    kind, old_name, new_name = sys.argv[1:]
    old = pathlib.Path(old_name)
    if not old.exists():
        return 0
    try:
        reader = {"plist": plist_keys, "systemd": systemd_keys}[kind]
        old_env, old_configuration = reader(old)
        new_env, new_configuration = reader(pathlib.Path(new_name))
        dropped_env = old_env - new_env
        dropped_configuration = old_configuration - new_configuration
        if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) for key in dropped_env):
            raise ValueError("Invalid environment key")
    except Exception:
        print("cortex render: cannot verify existing Cortex runtime configuration; refusing replacement", file=sys.stderr)
        return 1
    if dropped_env:
        print("cortex render: refusing to drop environment keys: " + ", ".join(sorted(dropped_env)), file=sys.stderr)
        print("Store surface secrets with `arc secrets set cortex NAME` before removing their old entries.", file=sys.stderr)
    if dropped_configuration:
        names = ", ".join(json.dumps(key, ensure_ascii=True) for key in sorted(dropped_configuration))
        print("cortex render: refusing to drop Cortex runtime configuration keys: " + names, file=sys.stderr)
        print("Migrate these settings or explicitly remove retired keys from the existing service, then retry.", file=sys.stderr)
    if dropped_env or dropped_configuration:
        print("Keep the existing service until these keys are migrated.", file=sys.stderr)
        return 1
    return 0


sys.exit(main())
