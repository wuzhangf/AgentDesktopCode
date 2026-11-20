from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from xagt_assets.acs_reader import AcsReader, AcsReaderError, AcsSourceHTTPError


FIXTURE = Path(__file__).parent / "fixtures" / "acs_public_read"
SESSION = "public-capture-session"


class Response:
    def __init__(self, value: dict, status: int = 200):
        self.status = status
        self._raw = json.dumps(value, separators=(",", ":")).encode()

    def read(self, *args):
        return self._raw if not args else self._raw[: args[0]]


class FixtureOpener:
    def __init__(self, pages: list[dict] | None = None):
        self.calls: list[tuple[str, str | None, str]] = []
        self.pages = pages

    def open(self, request, timeout=0):
        parsed = urlsplit(request.full_url)
        query = parse_qs(parsed.query)
        self.calls.append((request.method, request.get_header("Authorization"), request.full_url))
        assert request.method == "GET"
        if parsed.path.endswith("/foundation"):
            return Response(json.loads((FIXTURE / "foundation.json").read_text()))
        if parsed.path.endswith("/summary"):
            return Response(json.loads((FIXTURE / "summary.json").read_text()))
        if parsed.path.endswith("/messages"):
            if self.pages is not None:
                cursor = query.get("cursor", [None])[0]
                page = self.pages[0] if cursor is None else self.pages[1]
                return Response(page)
            return Response(json.loads((FIXTURE / "messages.json").read_text()))
        raise AssertionError(request.full_url)


def test_requires_explicit_observe_scope_without_making_a_request():
    with pytest.raises(AcsReaderError, match="OBSERVE"):
        AcsReader("http://127.0.0.1:54803/api/v2", SESSION)


def test_reads_compiled_acs_capture_and_preserves_provenance_and_auth():
    opener = FixtureOpener()
    reader = AcsReader(
        "http://127.0.0.1:54803/api/v2",
        SESSION,
        scope="OBSERVE",
        bearer="explicit-observe-token",
        installation_id="host-fixture",
        store_id="acs-store",
        opener=opener,
    )
    revision = reader.read()
    payload = revision.payload
    assert payload["source"]["kind"] == "acs-http"
    assert payload["source"]["adapterId"] == "xagt-acs-http/1"
    assert payload["source"]["readOnly"] is True
    assert payload["source"]["sessionId"] == SESSION
    assert payload["coverage"] == {
        "status": "complete",
        "pages": 1,
        "messages": 2,
        "pageSize": 100,
        "maxPages": 100,
        "maxMessages": 10000,
        "partialReasons": [],
        "hasOlder": False,
        "sourceVersion": 1,
        "transcriptRevision": "3",
        "attachments": "references-only",
        "capturedThrough": 1793997097667,
    }
    assert [row["messageId"] for row in payload["rows"]] == ["capture-user", "capture-assistant"]
    assert payload["rows"][0]["text"] == "CONTROL_PUBLIC_PACKET_user"
    assert len(payload["files"]) == 3
    assert len(revision.sourceFiles) == 3
    assert all(method == "GET" for method, _, _ in opener.calls)
    assert all(token == "Bearer explicit-observe-token" for _, token, _ in opener.calls)


def test_auth_is_off_when_bearer_is_not_supplied():
    opener = FixtureOpener()
    revision = AcsReader("http://localhost:54803", SESSION, scope={"OBSERVE"}, opener=opener).read()
    assert revision.payload["recordCount"] == 2
    assert all(token is None for _, token, _ in opener.calls)


def test_reads_older_pages_in_order_and_marks_partial_page():
    first = {
        "schemaVersion": "session-message-page/1", "sessionId": SESSION, "transcriptRevision": "9",
        "items": [{"id": "new", "role": "assistant", "content": "new", "createdAt": 2}],
        "beforeCursor": "older-1", "afterCursor": None, "hasOlder": True, "hasNewer": False,
        "rangeComplete": True,
    }
    second = {
        "schemaVersion": "session-message-page/1", "sessionId": SESSION, "transcriptRevision": "9",
        "items": [{"id": "old", "role": "user", "content": "old", "createdAt": 1}],
        "beforeCursor": None, "afterCursor": "older-1", "hasOlder": False, "hasNewer": False,
        "rangeComplete": False,
    }
    opener = FixtureOpener([first, second])
    revision = AcsReader("http://127.0.0.1:54803/api/v2", SESSION, scope="OBSERVE", opener=opener).read()
    assert [row["messageId"] for row in revision.payload["rows"]] == ["old", "new"]
    assert revision.payload["coverage"]["status"] == "partial"
    assert revision.payload["coverage"]["partialReasons"] == ["page_2_range_incomplete"]
    assert parse_qs(urlsplit(opener.calls[-2][2]).query) == {"limit": ["100"]}
    assert parse_qs(urlsplit(opener.calls[-1][2]).query) == {"limit": ["100"], "cursor": ["older-1"]}


def test_bounds_and_cursor_stall_never_claim_complete():
    page = {
        "schemaVersion": "session-message-page/1", "sessionId": SESSION, "transcriptRevision": "1",
        "items": [{"id": "m", "role": "user", "content": "x"}],
        "beforeCursor": "same", "afterCursor": None, "hasOlder": True, "hasNewer": False,
        "rangeComplete": True,
    }
    opener = FixtureOpener([page, page])
    revision = AcsReader("http://127.0.0.1:54803/api/v2", SESSION, scope="OBSERVE", opener=opener).read()
    assert revision.payload["coverage"]["status"] == "partial"
    assert "older_cursor_stalled" in revision.payload["coverage"]["partialReasons"]
    assert revision.payload["coverage"]["pages"] == 2


def test_rejects_cross_session_response():
    opener = FixtureOpener()
    original = opener.open

    def wrong_session(request, timeout=0):
        response = original(request, timeout)
        if request.full_url.endswith("/summary"):
            value = json.loads(response.read().decode())
            value["sessionId"] = "other-session"
            return Response(value)
        return response

    opener.open = wrong_session
    with pytest.raises(AcsReaderError, match="another session"):
        AcsReader("http://127.0.0.1:54803/api/v2", SESSION, scope="OBSERVE", opener=opener).read()


def test_rejects_path_traversal_and_redirects():
    with pytest.raises(AcsReaderError, match="path traversal"):
        AcsReader("http://127.0.0.1:54803", "..", scope="OBSERVE")

    class RedirectOpener:
        def open(self, request, timeout=0):
            return Response({}, status=302)

    with pytest.raises(AcsSourceHTTPError, match="redirect"):
        AcsReader("http://127.0.0.1:54803", SESSION, scope="OBSERVE", opener=RedirectOpener()).read()


def test_retries_one_upstream_409_and_pins_transcript_revision():
    class RetryOpener(FixtureOpener):
        def __init__(self):
            super().__init__()
            self.fail_once = True

        def open(self, request, timeout=0):
            if self.fail_once and urlsplit(request.full_url).path.endswith("/summary"):
                self.fail_once = False
                self.calls.append((request.method, request.get_header("Authorization"), request.full_url))
                return Response({}, status=409)
            return super().open(request, timeout)

    opener = RetryOpener()
    revision = AcsReader("http://127.0.0.1:54803", SESSION, scope="OBSERVE", opener=opener).read()
    assert revision.payload["coverage"]["status"] == "complete"

    class ChangedRevisionOpener(FixtureOpener):
        def open(self, request, timeout=0):
            response = super().open(request, timeout)
            if urlsplit(request.full_url).path.endswith("/messages") and "cursor=" in request.full_url:
                value = json.loads(response.read().decode())
                value["transcriptRevision"] = "different"
                return Response(value)
            return response

    first = {
        "schemaVersion": "session-message-page/1", "sessionId": SESSION, "transcriptRevision": "one",
        "items": [{"id": "new", "role": "assistant", "content": "new"}],
        "beforeCursor": "older", "hasOlder": True, "hasNewer": False, "rangeComplete": True,
    }
    second = {
        "schemaVersion": "session-message-page/1", "sessionId": SESSION, "transcriptRevision": "two",
        "items": [{"id": "old", "role": "user", "content": "old"}],
        "beforeCursor": None, "hasOlder": False, "hasNewer": False, "rangeComplete": True,
    }
    with pytest.raises(AcsReaderError, match="transcriptRevision changed"):
        AcsReader("http://127.0.0.1:54803", SESSION, scope="OBSERVE",
                  opener=FixtureOpener([first, second])).read()


def test_revision_id_is_stable_when_only_observation_times_change():
    opener_a = FixtureOpener()
    first = AcsReader("http://127.0.0.1:54803", SESSION, scope="OBSERVE", opener=opener_a).read()

    class ShiftedOpener(FixtureOpener):
        def open(self, request, timeout=0):
            response = super().open(request, timeout)
            value = json.loads(response.read().decode())
            def shift(node):
                if isinstance(node, dict):
                    for key in list(node):
                        if key in {"createdAt", "updatedAt", "observedAt", "capturedAt", "recordedAt"}:
                            if isinstance(node[key], int):
                                node[key] += 100000
                        else:
                            shift(node[key])
                elif isinstance(node, list):
                    for item in node:
                        shift(item)
            shift(value)
            return Response(value)

    second = AcsReader("http://127.0.0.1:54803", SESSION, scope="OBSERVE", opener=ShiftedOpener()).read()
    assert first.revisionId == second.revisionId
    assert first.payload["digest"] == second.payload["digest"]
    assert first.payload["rawDigest"] != second.payload["rawDigest"]
