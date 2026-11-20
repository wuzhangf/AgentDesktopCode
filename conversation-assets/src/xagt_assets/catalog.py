"""Page the conversation catalog using only scoped, non-content metadata."""

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from .api import Actor, PORTABLE_ID_PATTERN
from .store import AssetStore


def build_catalog_router(store: AssetStore, identity: Callable[..., Actor]) -> APIRouter:
    router = APIRouter()

    @router.get("/catalog")
    def catalog(
        response: Response,
        limit: int = Query(50, ge=1, le=100),
        after: str | None = Query(None, pattern=PORTABLE_ID_PATTERN),
        mode: Literal["cloudProcessable", "userHeld"] | None = None,
        actor: Actor = Depends(identity),
    ) -> dict:
        if not actor.can_read:
            raise HTTPException(403, detail={"code": "SCOPE_DENIED"})
        modes = sorted(store.allowed_modes) if mode is None else [mode]
        if mode is not None and mode not in store.allowed_modes:
            raise HTTPException(403, detail={"code": "MODE_DISABLED"})
        placeholders = ",".join("?" for _ in modes)
        with store.connection() as connection:
            rows = store._query(connection,
                "SELECT c.asset_id,c.updated_at,c.head_revision,r.mode "
                "FROM xagt_asset_conversations c JOIN xagt_asset_revisions r "
                "ON r.tenant_id=c.tenant_id AND r.workspace_id=c.workspace_id "
                "AND r.member_id=c.member_id AND r.asset_id=c.asset_id "
                "AND r.revision_id=c.head_revision "
                "WHERE c.tenant_id=? AND c.workspace_id=? AND c.member_id=? "
                f"AND c.deleted_at IS NULL AND c.asset_id>? AND r.mode IN ({placeholders}) "
                "ORDER BY c.asset_id LIMIT ?",
                (actor.tenant_id, actor.workspace_id, actor.member_id, after or "", *modes, limit + 1),
            )
        items = [{"assetId": row["asset_id"], "revisionId": row["head_revision"],
                  "mode": row["mode"], "updatedAt": row["updated_at"]} for row in rows[:limit]]
        response.headers["Cache-Control"] = "no-store"
        return {"schemaVersion": "xagt-asset-catalog/1", "items": items,
                "nextAfter": items[-1]["assetId"] if len(rows) > limit else None}

    return router
