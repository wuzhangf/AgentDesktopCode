"""Start a single-owner self-hosted conversation asset instance."""

from __future__ import annotations

import argparse
import hmac
import os

from fastapi import FastAPI, Header, HTTPException
import uvicorn

from .api import Actor, build_router
from .attachments import AttachmentService
from .collector import _validate_base_url
from .object_store import S3ObjectStore
from .store import AssetStore


def _token(variable: str, *, required: bool) -> bytes | None:
    value = os.environ.get(variable, "")
    if not value and not required:
        return None
    if len(value) < 32 or not value.isascii() or any(character.isspace() for character in value):
        raise ValueError(f"{variable} must contain a randomly generated token of at least 32 ASCII characters")
    return value.encode("ascii")


def _store() -> AssetStore:
    dsn = os.environ.get("XAGT_ASSETS_DSN", "")
    if not dsn:
        raise ValueError("XAGT_ASSETS_DSN is required")
    try:
        key = bytes.fromhex(os.environ.get("XAGT_ASSETS_CLOUD_KEY", ""))
    except ValueError as error:
        raise ValueError("XAGT_ASSETS_CLOUD_KEY must be a 32-byte key in hex form") from error
    if len(key) != 32:
        raise ValueError("XAGT_ASSETS_CLOUD_KEY must be a 32-byte key in hex form")
    return AssetStore(dsn, cloud_key=key)


def _attachments(store: AssetStore) -> AttachmentService | None:
    setting_names = ("ENDPOINT", "BUCKET", "ACCESS_KEY", "SECRET_KEY")
    settings = {name: os.environ.get(f"XAGT_ASSETS_S3_{name}", "") for name in setting_names}
    if not any(settings.values()):
        return None
    if not all(settings.values()):
        raise ValueError("S3 attachment storage requires endpoint, bucket and both credentials")
    endpoint = _validate_base_url(settings["ENDPOINT"])
    backend = S3ObjectStore(endpoint, settings["BUCKET"], settings["ACCESS_KEY"], settings["SECRET_KEY"],
                            region=os.environ.get("XAGT_ASSETS_S3_REGION", "us-east-1"),
                            session_token=os.environ.get("XAGT_ASSETS_S3_SESSION_TOKEN"))
    limit = int(os.environ.get("XAGT_ASSETS_MAX_ATTACHMENT_BYTES", str(16 * 1024 * 1024)))
    return AttachmentService(store, backend, max_bytes=limit)


def build_app(store: AssetStore, *, owner_token: bytes, collector_token: bytes | None = None,
              attachments: AttachmentService | None = None) -> FastAPI:
    if collector_token and hmac.compare_digest(owner_token, collector_token):
        raise ValueError("the owner and collector must have different tokens")

    def identify(authorization: str | None = Header(default=None)) -> Actor:
        scheme, _, value = (authorization or "").partition(" ")
        if scheme.lower() == "bearer" and value.isascii():
            given = value.encode("ascii")
            if hmac.compare_digest(given, owner_token):
                return Actor("local", "default", "owner", "owner", can_ingest=True, can_manage=True, can_read=True)
            if collector_token and hmac.compare_digest(given, collector_token):
                return Actor("local", "default", "owner", "collector", can_ingest=True)
        raise HTTPException(401, detail={"code": "UNAUTHENTICATED"}, headers={"WWW-Authenticate": "Bearer"})

    app = FastAPI(title="xagt.link Conversation Assets")
    app.include_router(build_router(store, identify, attachments=attachments), prefix="/assets/v1")
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "cleanup-attachments"))
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    try:
        store = _store()
        if args.command == "init":
            store.apply_schema()
            print("Conversation asset schema ready")
            return 0
        store.check_schema()
        attachments = _attachments(store)
        if args.command == "cleanup-attachments":
            if attachments is None:
                parser.error("S3 attachment storage is required")
            removed = attachments.cleanup_staged()
            print(f"Expired attachment records cleaned: {removed}")
            return 0
        owner = _token("XAGT_ASSETS_OWNER_TOKEN", required=True)
        collector = _token("XAGT_ASSETS_COLLECTOR_TOKEN", required=False)
        app = build_app(store, owner_token=owner, collector_token=collector, attachments=attachments)
    except ValueError as error:
        parser.error(str(error))
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, server_header=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
