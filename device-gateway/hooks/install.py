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
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "agent_pre_tool.py"
MARKER = "agent_pre_tool.py"
PRE_TOOL_TIMEOUT = 360  # hook blocks up to ~290s polling; 60s would kill it
CONFIG_DIR = Path.home() / ".agent-gateway"


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except ValueError:
        backup = path.with_name(path.name + ".corrupt.bak")
        shutil.copy2(path, backup)
        print(f"{path} is not valid JSON, backed up to {backup.name}", file=sys.stderr)
        return {}


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


def hook_command(agent: str) -> str:
    return f'"{sys.executable}" "{SCRIPT}" {agent}'


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
    for i, group in enumerate(event):
        cmds = [h.get("command") or "" for h in group.get("hooks") or [] if isinstance(h, dict)]
        if any(MARKER in c for c in cmds):
            event[i] = entry
            break
    else:
        event.append(entry)
    hooks["PreToolUse"] = event
    settings["hooks"] = hooks
    write_json(settings_path, settings)
    print(f"installed: {settings_path} -> PreToolUse {hook_command(agent)}")


def uninstall(settings_path: Path) -> None:
    settings = read_json(settings_path)
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    event = hooks.get("PreToolUse")
    if isinstance(event, list):
        kept = [g for g in event
                if not any(MARKER in (h.get("command") or "")
                           for h in (g.get("hooks") or []) if isinstance(h, dict))]
        if kept != event:
            if kept:
                hooks["PreToolUse"] = kept
            else:
                hooks.pop("PreToolUse", None)
            settings["hooks"] = hooks
            write_json(settings_path, settings)
            print(f"removed our hook from {settings_path}")
            return
    print("nothing to remove")


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
        try:
            (CONFIG_DIR / "hooks.json").unlink()
        except OSError:
            pass
        return 0

    if not args.port or not args.token_file:
        sys.exit("need --port N and --token-file PATH (the gateway prints its "
                 "hooks port at startup; token file is {dataDir}/hooks.token)")
    if not Path(args.token_file).exists():
        sys.exit(f"token file not found: {args.token_file}")

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
