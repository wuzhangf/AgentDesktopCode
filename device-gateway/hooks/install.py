#!/usr/bin/env python3
"""Install agent-gateway hooks into ~/.claude/settings.json.

Merges ONE PreToolUse entry — our script — into the user's settings, replacing
an earlier entry of ours if present and never touching the user's own hooks.
Also writes ~/.agent-gateway/hooks.json telling the hook where the gateway's
loopback surface and its token live.

Usage: install.py [--port N] [--token-file PATH] [--uninstall]
"""

import argparse
import json
import os
import shutil
import shlex
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "agent_pre_tool.py"
MARKER = "agent_pre_tool.py"
PRE_TOOL_TIMEOUT = 360  # hook blocks up to ~290s polling; 60s would kill it
CONFIG_DIR = Path.home() / ".agent-gateway"
# The global agent configs must never reference a repo checkout — a split,
# archive or move leaves every tool call spawning a missing script. Stage the
# hook under ~/.agent-gateway and register that stable path; the shebang +
# stdlib-only script keeps it free of any interpreter path too.
STAGED = CONFIG_DIR / "hooks" / "agent_pre_tool.py"
INSTALLER_STAGED = CONFIG_DIR / "hooks" / "install.py"


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            sys.exit(f"{path} must contain a JSON object")
        return data
    except ValueError:
        backup = path.with_name(path.name + ".corrupt.bak")
        shutil.copy2(path, backup)
        print(f"{path} is not valid JSON, backed up to {backup.name}", file=sys.stderr)
        sys.exit(f"Repair {path} before installing or removing the hook")


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp.", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def stage() -> Path:
    """Copy the hook and this installer into ~/.agent-gateway/hooks; refresh on
    every install so upstream fixes propagate to already-registered configs
    and the installer itself survives repo moves."""
    if not SCRIPT.exists():
        sys.exit(f"hook source missing: {SCRIPT}")
    STAGED.parent.mkdir(parents=True, exist_ok=True)
    for src, dst in [(SCRIPT, STAGED),
                     (Path(__file__).resolve(), INSTALLER_STAGED)]:
        if src.resolve() == dst.resolve():
            continue
        tmp = dst.with_suffix(".tmp")
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
        dst.chmod(0o755)
    return STAGED


def hook_command(agent: str) -> str:
    return f'{shlex.quote(sys.executable)} {shlex.quote(str(STAGED))} {agent}'


AGENTS = {
    "claude": Path.home() / ".claude" / "settings.json",
    "codex": Path.home() / ".codex" / "hooks.json",
}


def install(agent: str, settings_path: Path) -> None:
    settings = read_json(settings_path)
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    event = list(hooks.get("PreToolUse") or [])
    entry = {"matcher": "*",
             "hooks": [{"type": "command", "command": hook_command(agent),
                        "timeout": PRE_TOOL_TIMEOUT}]}
    event = without_our_hooks(event)
    event.append(entry)
    hooks["PreToolUse"] = event
    settings["hooks"] = hooks
    write_json(settings_path, settings)
    print(f"installed: {settings_path} -> PreToolUse {hook_command(agent)}")


def without_our_hooks(event: list) -> list:
    kept = []
    for group in event:
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            kept.append(group)
            continue
        original = group["hooks"]
        remaining = [h for h in original
                     if not isinstance(h, dict) or MARKER not in str(h.get("command", ""))]
        if remaining == original:
            kept.append(group)
        elif remaining:
            kept.append({**group, "hooks": remaining})
    return kept


def uninstall(settings_path: Path) -> None:
    settings = read_json(settings_path)
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict) or not isinstance(hooks.get("PreToolUse"), list):
        return
    event = hooks["PreToolUse"]
    kept = without_our_hooks(event)
    if kept == event:
        return
    if kept:
        hooks["PreToolUse"] = kept
    else:
        hooks.pop("PreToolUse")
    write_json(settings_path, settings)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--token-file", default="")
    ap.add_argument("--agents", default=",".join(k for k in AGENTS
                                               if AGENTS[k].parent.exists()),
                    help="comma list: claude,codex (default: detected)")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    agents = [a.strip() for a in args.agents.split(",") if a.strip() in AGENTS]
    if args.uninstall:
        for agent in agents:
            uninstall(AGENTS[agent])
        # Keep the shared script/config for other agents and in-flight calls.
        return 0

    if not args.port or not args.token_file:
        sys.exit("need --port N and --token-file PATH (the gateway prints its "
                 "hooks port at startup; token file is {dataDir}/hooks.token)")
    if not Path(args.token_file).exists():
        sys.exit(f"token file not found: {args.token_file}")

    stage()
    for agent in agents:
        install(agent, AGENTS[agent])
    if "codex" in agents:
        codex_cfg = Path.home() / ".codex" / "config.toml"
        try:
            if "hooks" not in codex_cfg.read_text():
                print("note: enable [features] hooks=true in ~/.codex/config.toml")
        except OSError:
            pass
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    write_json(CONFIG_DIR / "hooks.json",
               {"port": args.port, "tokenFile": str(Path(args.token_file).resolve())})
    print(f"config: {CONFIG_DIR / 'hooks.json'} port={args.port}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
