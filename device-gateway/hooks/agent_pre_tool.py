#!/usr/bin/env python3
"""PreToolUse bridge: agent tool call -> device-gateway approvals -> phone.

Spawned by the agent for every tool call. Reads the hook payload on stdin,
asks the paired phone through the gateway's loopback hooks surface, and prints
the agent-dialect decision on stdout.

Fail-open contract: any error, any unreachable gateway, no paired phone, or a
poll timeout exits 0 with NO output — the agent then shows its own desktop
dialog. The phone path must never strand a tool call.

Config: ~/.agent-gateway/hooks.json {"port": N, "tokenFile": path}
Session auto-approve: ~/.agent-gateway/auto-{session_id} marker file.

Usage: agent_pre_tool.py <agent>     (agent = claude, codex, ...)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

POLL_INTERVAL_S = 2.0
ANSWER_TIMEOUT_S = 290.0

# Tools worth a phone card. Everything else exits silently and the agent's own
# permission logic decides — unknown new tools fail safe to the desktop.
RISKY = {
    "claude": {"Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
               "WebFetch", "WebSearch"},
}
# Codex names are less stable, so the filter inverts: ask for everything
# except this known-harmless set (mirrors the pattern other bridges use).
HARMLESS = {
    "codex": {"update_plan", "web_search", "view_image", "read_file",
              "list_dir", "grep", "glob"},
}


def worth_asking(agent: str, tool: str) -> bool:
    if tool.startswith("mcp__") or tool.startswith("MCP:"):
        return True
    if agent in RISKY:
        return tool in RISKY[agent]
    return tool not in HARMLESS.get(agent, set())


def log(msg: str) -> None:
    try:
        p = Path.home() / ".agent-gateway" / "hooks.log"
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except OSError:
        pass


def load_config() -> dict | None:
    try:
        cfg = json.loads((Path.home() / ".agent-gateway" / "hooks.json").read_text())
        if cfg.get("port") and cfg.get("tokenFile"):
            return cfg
    except (OSError, ValueError):
        pass
    return None


def read_token(cfg: dict) -> str | None:
    try:
        token = Path(cfg["tokenFile"]).read_text().strip()
        return token or None
    except OSError:
        return None


def call(cfg: dict, token: str, method: str, path: str,
         body: dict | None = None, timeout: float = 5.0) -> dict | None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{cfg['port']}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"authorization": f"Bearer {token}",
                 "content-type": "application/json"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())
    except (OSError, urllib.error.HTTPError, ValueError) as e:
        log(f"{method} {path} failed: {e}")
        return None


def approve_out(agent: str) -> str:
    if agent == "codex":
        return json.dumps({"hookSpecificOutput": {"permissionDecision": "approve"}})
    return json.dumps({"decision": "approve"})  # Claude Code dialect


def block_out(agent: str, reason: str) -> str:
    if agent == "codex":
        return json.dumps({"hookSpecificOutput": {
            "permissionDecision": "deny",
            "permissionDecisionReason": reason}})
    return json.dumps({"decision": "block", "reason": reason})


def question_for(tool: str, tool_input: dict) -> str:
    path = tool_input.get("file_path") or tool_input.get("path") or ""
    cmd = tool_input.get("command") or ""
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    cmd = str(cmd).strip()
    if tool in ("Write", "write_file"):
        return f"创建 / 覆写: {path or '一个文件'}"
    if tool in ("Edit", "MultiEdit", "NotebookEdit", "apply_patch", "replace_in_file"):
        return f"编辑: {path or '一个文件'}"
    if tool in ("Bash", "shell", "run_shell_command", "Shell", "run_terminal_cmd"):
        return f"运行: {cmd[:140]}"
    if tool in ("WebFetch", "WebSearch"):
        detail = tool_input.get("url") or tool_input.get("query") or ""
        return f"{tool}: {str(detail)[:140]}"
    if tool.startswith("mcp__"):
        return f"允许 MCP 工具 {tool}?"
    return f"允许 {tool}?"


def session_auto(agent: str, session_id: str) -> bool:
    if not session_id:
        return False
    flag = Path.home() / ".agent-gateway" / f"auto-{agent}-{session_id}"
    return flag.exists()


def mark_session_auto(agent: str, session_id: str) -> None:
    if not session_id:
        return
    try:
        flag = Path.home() / ".agent-gateway" / f"auto-{agent}-{session_id}"
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text(str(time.time()))
    except OSError:
        pass


def main() -> int:
    agent = sys.argv[1] if len(sys.argv) > 1 else "claude"
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0  # not a payload we understand — desktop flow

    tool = payload.get("tool_name") or payload.get("toolName") or ""
    tool_input = payload.get("tool_input") or payload.get("toolInput") or {}
    session_id = payload.get("session_id") or payload.get("conversation_id") or ""
    cwd = payload.get("cwd") or payload.get("workdir") or ""
    tool_use_id = (payload.get("tool_use_id") or payload.get("toolUseId")
                   or payload.get("tool_call_id") or "")

    # Master switch: Agent Link's "手机协同" toggle writes link.state; off
    # means every tool call passes silently to the desktop dialog.
    try:
        state = json.loads((Path.home() / ".agent-gateway" / "link.state").read_text())
        if state.get("enabled") is False:
            return 0
    except (OSError, ValueError):
        pass  # no state file — cooperative mode stays on

    if not tool or not worth_asking(agent, tool):
        return 0
    if session_auto(agent, session_id):
        print(approve_out(agent))
        return 0

    cfg = load_config()
    if cfg is None:
        return 0
    token = read_token(cfg)
    if token is None:
        return 0
    enabled = call(cfg, token, "GET", "/hooks/v1/enabled", timeout=3.0)
    if not enabled or not enabled.get("enabled"):
        return 0  # no paired phone — desktop dialog handles it

    approval_id = f"{agent}-{tool_use_id or str(int(time.time() * 1000))}"[:128]
    ask = call(cfg, token, "POST", "/hooks/v1/approvals", body={
        "approvalId": approval_id,
        "agent": agent,
        "toolName": tool,
        "toolInput": tool_input if isinstance(tool_input, dict) else {},
        "question": question_for(tool, tool_input if isinstance(tool_input, dict) else {}),
        "options": ["允许一次", "本会话允许", "拒绝"],
        "projectDir": cwd,
        "sessionRef": session_id,
        "ttlMillis": int(ANSWER_TIMEOUT_S * 1000),
    })
    if not ask or ask.get("state") != "PENDING":
        return 0

    deadline = time.time() + ANSWER_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        row = call(cfg, token, "GET", f"/hooks/v1/approvals/{approval_id}", timeout=3.0)
        if row is None:
            continue
        state = row.get("state")
        if state == "PENDING":
            continue
        if state == "APPROVED":
            if row.get("decision") == "APPROVED_SESSION":
                mark_session_auto(agent, session_id)
            print(approve_out(agent))
            return 0
        if state == "DENIED":
            print(block_out(agent, row.get("reason") or "已从手机拒绝。"))
            return 0
        return 0  # EXPIRED / CANCELLED / unknown → desktop flow

    # Timed out: pull the card down so the phone doesn't show a stale question.
    call(cfg, token, "POST", f"/hooks/v1/approvals/{approval_id}/cancel")
    return 0


if __name__ == "__main__":
    sys.exit(main())
