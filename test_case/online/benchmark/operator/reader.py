"""Run one blinded Hermes native turn. The parent owns billing and transport."""
import contextlib
import hashlib
import json
import logging
import os
import pathlib
import runpy
import socket
import subprocess
import sys
from unittest.mock import patch

def require(value, reason):
    if not value:
        raise RuntimeError(reason)

def main():
    item = json.loads(sys.stdin.readline())
    root = pathlib.Path(item["hermes"])
    actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    require(actual == "97a9ae8ee55d31bebce49f1fb6b5ef775323976a", "unsupported Hermes revision")
    require(not subprocess.check_output(["git", "-C", str(root), "diff", "HEAD", "--"]), "modified Hermes runtime")
    sys.path.insert(0, str(root))
    logging.disable(logging.CRITICAL)
    channel = sys.stdout
    def emit(data):
        channel.write(json.dumps(data, separators=(",", ":")) + "\n")
        channel.flush()
    def deny(*args, **kwargs):
        raise RuntimeError("Direct reader network disabled")
    # Dependencies belong to the operator-selected interpreter. Import the embedded
    # API without invoking Hermes CLI update, installation or environment selection.
    with contextlib.redirect_stdout(sys.stderr), patch("hermes_cli.venv_sync.prepare_launch", return_value=None), patch("hermes_cli._early_recovery.recover_if_needed"), patch("pm.environments.activate_dependencies"):
        import hermes_bootstrap
    # The request crosses the parent's sole metered dispatch point. Hermes never holds an API credential.
    with contextlib.redirect_stdout(sys.stderr), patch.object(socket.socket, "connect", deny):
        import httpx
        from hermes_constants import parse_reasoning_effort
        from run_agent import AIAgent
        runpy.run_path(str(root / "plugins/model-providers/opencode-zen/__init__.py"))
        agent = AIAgent(provider="opencode-go", base_url="https://opencode.ai/inference/go/openai/v1",
                        api_mode="chat_completions", model="deepseek-v4.1-flash", api_key="local-transport",
                        enabled_toolsets=[], disabled_toolsets=["all"], skip_context_files=True,
                        load_soul_identity=False, skip_memory=True, skip_background_review=True,
                        save_trajectories=False, session_db=None, quiet_mode=True, max_iterations=1,
                        max_tokens=49152, reasoning_config=parse_reasoning_effort("ultra"),
                        request_overrides={"extra_body":{"thinking":{"type":"enabled"}}}, fallback_model=None)
        agent.compression_enabled = False
        agent._api_max_retries = 1
        agent._auto_recovery_cycles = 0
        agent._build_system_prompt = lambda *args, **kwargs: ""
        require(not agent.tools and not agent._fallback_chain and not agent._session_db and agent.session_id, "reader isolation")
        query = item["query"]
        original = agent._build_api_kwargs
        def build(messages, *args, **kwargs):
            wire = original(messages, *args, **kwargs)
            require(len(wire["messages"]) == 1 and wire["messages"][0]["role"] == "user" and wire["messages"][0]["content"].strip() == query.strip(), "extra prompt content")
            wire["messages"] = [{"role":"user", "content":query}]
            return wire
        agent._build_api_kwargs = build
        calls = []
        def send(client, req, **kwargs):
            require(not calls and req.method == "POST" and str(req.url) == "https://opencode.ai/inference/go/openai/v1/chat/completions", "unexpected reader request")
            wire = json.loads(req.content)
            require(wire == {"messages":[{"role":"user","content":query}],"model":"deepseek-v4.1-flash",
                    "max_tokens":49152,"reasoning_effort":"max","stream":True,"stream_options":{"include_usage":True},"thinking":{"type":"enabled"}}, "reader wire drift")
            require(req.headers.get("x-opencode-session") == agent.session_id and "hermes" in req.headers["user-agent"].lower(), "reader identity drift")
            calls.append(hashlib.sha256(req.content).hexdigest())
            emit({"type":"wire", "body":req.content.decode(), "sha256":calls[0], "session":agent.session_id, "userAgent":req.headers["user-agent"]})
            result=json.loads(sys.stdin.readline())
            require(isinstance(result.get("sse"),str), "reader transport failed")
            return httpx.Response(200, headers={"Content-Type":"text/event-stream"},content=result["sse"].encode(),request=req)
        with patch.object(httpx.Client, "send", send):
            result=agent.run_conversation(query, conversation_history=[])
        require(len(calls)==1 and result.get("api_calls")==1 and isinstance(result.get("final_response"),str), "incomplete native reader turn")
        emit({"type":"result","raw":result["final_response"],"wire":calls[0],"release":actual,"session":agent.session_id})
if __name__ == "__main__":
    main()
