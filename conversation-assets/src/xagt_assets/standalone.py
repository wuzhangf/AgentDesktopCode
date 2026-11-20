"""Start a single-owner self-hosted conversation asset instance."""

from __future__ import annotations

import argparse
import hmac
import json
import os

from fastapi import FastAPI, Header, HTTPException
import uvicorn

from .api import Actor, build_router
from .attachments import AttachmentService
from .catalog import build_catalog_router
from .collector import _validate_base_url
from .object_store import S3ObjectStore
from .read_grants import apply_grant_schema, build_grant_router, check_grant_schema
from .recovery import verify_storage
from .search import build_search_router
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
    configured_key = os.environ.get("XAGT_ASSETS_CLOUD_KEY")
    if configured_key is None:
        return AssetStore(dsn, cloud_key=None, allowed_modes={"userHeld"})
    try:
        key = bytes.fromhex(configured_key)
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
              attachments: AttachmentService | None = None, enable_search: bool = False,
              enable_read_grants: bool = False) -> FastAPI:
    if collector_token and hmac.compare_digest(owner_token, collector_token):
        raise ValueError("the owner and collector must have different tokens")
    if enable_search and "cloudProcessable" not in store.allowed_modes:
        raise ValueError("search requires the private instance cloud key")
    if enable_read_grants:
        check_grant_schema(store)

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

    @app.middleware("http")
    async def disable_asset_caching(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/assets/v1/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(build_router(store, identify, attachments=attachments), prefix="/assets/v1")
    app.include_router(build_catalog_router(store, identify), prefix="/assets/v1")
    if enable_search:
        app.include_router(build_search_router(store, identify), prefix="/assets/v1")
    if enable_read_grants:
        app.include_router(build_grant_router(store, identify), prefix="/assets/v1")
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "serve", "cleanup-attachments", "verify-storage"))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--enable-search", action="store_true", help="serve private keyword search")
    parser.add_argument("--enable-read-grants", action="store_true", help="initialize or serve exact-revision read grants")
    args = parser.parse_args(argv)
    try:
        store = _store()
        if args.command == "init":
            store.apply_schema()
            if args.enable_read_grants:
                apply_grant_schema(store)
            print("Conversation asset schema ready")
            return 0
        store.check_schema()
        attachments = _attachments(store)
        if args.command == "verify-storage":
            if args.enable_read_grants:
                check_grant_schema(store)
            result = verify_storage(store, attachments.object_store if attachments is not None else None)
            print(json.dumps(result.report()))
            return 0 if result.ok else 2
        if args.command == "cleanup-attachments":
            if attachments is None:
                parser.error("S3 attachment storage is required")
            removed = attachments.cleanup_staged()
            print(f"Expired attachment records cleaned: {removed}")
            return 0
        owner = _token("XAGT_ASSETS_OWNER_TOKEN", required=True)
        collector = _token("XAGT_ASSETS_COLLECTOR_TOKEN", required=False)
        app = build_app(store, owner_token=owner, collector_token=collector, attachments=attachments,
                        enable_search=args.enable_search, enable_read_grants=args.enable_read_grants)
    except (ValueError, RuntimeError) as error:
        parser.error(str(error))
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, server_header=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
