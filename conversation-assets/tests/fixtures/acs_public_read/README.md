# ACS public-read qualification fixture

These three responses are a sanitized capture from an isolated, zero-model ACS
runtime. `SessionService` created the session and the compiled
`SqliteSessionHistoryReadRepository` / `SessionHistoryQueryService` emitted the
foundation, summary, and messages responses. The capture was made on
2026-11-07 from the existing PAC-A public-read fixture; no user or private
transcript data, credentials, or HTTP headers are included.

This fixture qualifies the DTO shape and pagination contract only. It does not
qualify network authentication, TLS, a production ACS endpoint, or model
completion. The test transport serves these captured responses so the reader
can be verified without contacting production.
