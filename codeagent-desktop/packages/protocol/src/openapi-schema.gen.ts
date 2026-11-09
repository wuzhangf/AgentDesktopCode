export interface paths {
    "/api/v2/client-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List safe active client-session projections for the local owner */
        get: operations["listClientSessions"];
        put?: never;
        /** Register one Electron/Web/CLI/Swing process for this Service boot */
        post: operations["registerClientSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/client-sessions/{clientSessionId}/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh a live client session using its in-memory secret */
        post: operations["heartbeatClientSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/client-sessions/{clientSessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke this client session; repeating the same request is idempotent */
        delete: operations["revokeClientSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/operations/{receiptId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a previously accepted operation receipt */
        get: operations["getOperationReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/operations/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Look up an operation without admitting or replaying it */
        post: operations["lookupOperationReceipt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/event-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a bounded scope snapshot at a fixed journal high-water mark */
        get: operations["getEventSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session list (v2) */
        get: operations["listSessions"];
        put?: never;
        /** Create a Session (additive Session v2 API) */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/summaries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Keyset-paginated session summaries (history pagination; capability session.summary.list) */
        get: operations["listSessionSummaries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session view (messages on inspect responses) */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Optimistic session mutation */
        patch: operations["patchSession"];
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/foundation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read registered shared-owner session identity and immutable Worker binding */
        get: operations["getSessionFoundation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/observation-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Capture bounded immutable read-only progress; never pauses or calls a model */
        post: operations["createObservationSnapshot"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/observation-snapshots/{snapshotId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read frozen snapshot manifest */
        get: operations["getObservationSnapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/observation-snapshots/{snapshotId}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read only the stored frozen bytes */
        get: operations["pageObservationSnapshotItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/model-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Versioned desired/effective model settings */
        get: operations["getSessionModelSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Atomically replace model settings for the next safe request */
        patch: operations["patchSessionModelSettings"];
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One lightweight session summary (capability session.summary.read) */
        get: operations["getSessionSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session contract/status projection without a messages field (capability session.metadata.read) */
        get: operations["getSessionMetadata"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session-scoped page of persisted execution records, newest first (design 2026-09-26-evidence §10.2). Only records whose own sessionId matches the path session are returned. */
        get: operations["listSessionExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/executions/{executionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One execution record. A foreign-session executionId is indistinguishable from a missing one — no existence leak. */
        get: operations["getSessionExecution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/executions/{executionId}/artifacts/{artifactPath}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Bounded slice of a captured artifact (stdout/stderr logs, record documents). The path must stay inside the execution's record directory; expired tombstones report ARTIFACT_EXPIRED. */
        get: operations["readSessionExecutionArtifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Keyset message page, oldest → newest (capability session.messages.page) */
        get: operations["pageSessionMessages"];
        put?: never;
        /** Accept a user message (202 Accepted; run progresses asynchronously) */
        post: operations["sendSessionMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/messages/{messageId}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Bounded UTF-8 segment of one message body (capability session.message.content.read)
         * @description Segments concatenate only while contentRevision stays identical. maxBytes bounds the entire JSON response including escaping, not the raw text length; segments never split UTF-8 sequences.
         */
        get: operations["getMessageContentPage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/messages/{messageId}/attachments/{attachmentId}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read accepted text-attachment content (bounded UTF-8 text/plain; Markdown is not rendered as HTML) */
        get: operations["getSessionAttachmentContent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/messages/{messageId}/attachments/{attachmentId}/bytes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read accepted image-attachment bytes from the server-owned blob store (multimodal design 7.8, WU-10)
         * @description Serves the original PNG/JPEG bytes of an IMAGE attachment. Session, message and attachment ownership is validated before the blob is read; a mismatching blob hash fails with INPUT_ASSET_HASH_MISMATCH and a missing blob with INPUT_ASSET_MISSING instead of silently degrading. Responses carry the authoritative image media type, Content-Length, Cache-Control: private, no-store and X-Content-Type-Options: nosniff. Text attachments must use the sibling content endpoint.
         */
        get: operations["getSessionAttachmentBytes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/forks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Fork a session lineage */
        post: operations["forkSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Archive a session */
        post: operations["archiveSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/attention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Open attention items (read model; never the approval authority) */
        get: operations["listAttention"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/specs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Draft a spec for the session (Task Contract v2) */
        post: operations["createSpec"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/specs/{specId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Spec view with contract markdown and fingerprints */
        get: operations["getSpec"];
        put?: never;
        /** Optimistic spec revision (expectedRevision) */
        post: operations["reviseSpec"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/specs/{specId}/approvals/{approvalId}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve/reject a spec revision with fingerprint guards */
        post: operations["decideSpecApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/specs/{specId}/convert-to-act": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Convert an approved spec into a governed Task */
        post: operations["convertSpecToAct"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/gui/runs/{runId}/command-approval": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the pending command approval projection */
        get: operations["getCommandApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/gui/runs/{runId}/command-approval/{approvalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decide a pending command approval (fingerprint-guarded) */
        post: operations["decideCommandApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/gui/runs/{runId}/budget-approval": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the pending budget approval projection */
        get: operations["getBudgetApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/gui/runs/{runId}/budget-approval/{approvalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decide a pending budget approval (requestFingerprint-guarded) */
        post: operations["decideBudgetApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runs/{runId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a run; cancel never auto-resumes */
        post: operations["cancelRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Capability handshake and feature flags */
        get: operations["getCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/execution-backends": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the cached, safe execution-backend projection */
        get: operations["getExecutionBackends"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/execution-backends/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force one bounded, single-flight backend probe */
        post: operations["refreshExecutionBackends"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/execution-policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the effective execution permission policy for a session */
        get: operations["getSessionExecutionPolicy"];
        /** Update the execution permission policy (trusted principal required) */
        put: operations["updateSessionExecutionPolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/automation-controls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the durable automation queue control for a session */
        get: operations["getSessionAutomationControl"];
        put?: never;
        /** Pause or resume automatic approval dispatch for a session */
        post: operations["controlSessionAutomation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/me/execution-policy-defaults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the caller's user-scope execution policy defaults */
        get: operations["getMyExecutionPolicyDefaults"];
        /** Update user execution policy defaults (trusted principal required) */
        put: operations["updateMyExecutionPolicyDefaults"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/execution-policy-defaults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read project execution policy defaults */
        get: operations["getProjectExecutionPolicyDefaults"];
        /** Update project execution policy defaults (trusted principal required) */
        put: operations["updateProjectExecutionPolicyDefaults"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sessionId}/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List durable approval projections for a session */
        get: operations["listSessionApprovals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/approvals/{approvalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one authoritative approval projection */
        get: operations["getApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/approvals/{approvalId}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decide one approval with version and fingerprint guards */
        post: operations["decideApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/approvals/{approvalId}/advance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Advance a delayed approval when its server-side due time has arrived */
        post: operations["advanceApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/approvals/{approvalId}/controls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply a guarded approval control (pause, resume or cancel) */
        post: operations["controlApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{businessSessionId}/terminal-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List terminal sessions owned by a business session */
        get: operations["listTerminalSessions"];
        put?: never;
        /** Create a governed stateful terminal session */
        post: operations["createTerminalSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a terminal session snapshot */
        get: operations["getTerminalSession"];
        put?: never;
        post?: never;
        /** Close a terminal session */
        delete: operations["closeTerminalSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/control/acquire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acquire the single-controller terminal lease */
        post: operations["acquireTerminalControl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/control/renew": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Renew the current terminal control lease */
        post: operations["renewTerminalControl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/control/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Release the current terminal control lease */
        post: operations["releaseTerminalControl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/output": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read bounded terminal output from an opaque cursor */
        get: operations["getTerminalOutput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/output/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream terminal output as SSE */
        get: operations["streamTerminalOutput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Write user-controlled input to a terminal session */
        post: operations["writeTerminalInput"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/resize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resize a terminal session using latest-wins sequencing */
        post: operations["resizeTerminalSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/terminal-sessions/{terminalSessionId}/signals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send a governed interrupt or terminate signal */
        post: operations["signalTerminalSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Registered projects visible to this service */
        get: operations["listProjects"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/registrations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a local project from an absolute path. High-risk local
         *     entry: only the Electron main may call it; the service canonicalizes
         *     the path, requires an existing directory and rejects symlinks. Git is
         *     optional: Git-backed projects expose VCS features, while ordinary
         *     directories remain usable for workspace read/write operations.
         */
        post: operations["registerProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Project summary */
        get: operations["getProject"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Detailed project status (workspace identity, dirty state) */
        get: operations["getProjectStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/session-preflight": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve the server-owned inputs for creating a session */
        get: operations["getProjectSessionPreflight"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/build-plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolved build plan per detected target (design 2026-09-26 §7.2) — recipe-driven argv dry run, readiness facts, effective overrides. Never spawns a process. */
        get: operations["getProjectBuildPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/build-plan/overrides": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Validate and persist a user build-plan override (runner / argv / env / disabled). Rows bind the live workspace fingerprint and turn STALE on drift. */
        put: operations["putProjectBuildPlanOverride"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/build-plan/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Render a candidate override's resolved plan without persisting — identical validation and resolver semantics as PUT. */
        post: operations["previewProjectBuildPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/verification-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the project's persisted verification profiles (design 2026-09-26 §7.4/§10.2). Each profile carries its optimistic revision and the configDigest that plan fingerprints bind to. */
        get: operations["listVerificationProfiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/verification-profiles/{profileId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one verification profile */
        get: operations["getVerificationProfile"];
        /** Create or update a verification profile under optimistic control. If-Match carries the client's known revision (a bare number or quoted etag); a create omits it and fails when the profile already exists. */
        put: operations["putVerificationProfile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/files/{fileRef}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read bounded UTF-8 content from a server-authorized workspace file */
        get: operations["readProjectFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/native-open-intents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mint a short-lived signed intent (REVEAL | IDE | USER_TERMINAL |
         *     REVEAL_FILE) for the Electron main to open a native shell for the
         *     project. The intent expires in 30 seconds and never carries an
         *     arbitrary executable.
         */
        post: operations["createNativeOpenIntent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Run list for the Task Center */
        get: operations["listRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/scheduler/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Scheduler capacity, recovery barrier, and resource-pool projection */
        get: operations["getSchedulerOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Authoritative run view; terminal state is only taken from here */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/scheduling": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Authoritative scheduling projection for one run */
        get: operations["getRunScheduling"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/commands": {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        /** Read bounded durable history, newest admission first */
        get: operations["listRunCommands"];
        put?: never;
        /**
         * Persist a lifecycle intent; acceptance does not confirm execution
         * @description Requires session.foundation.enabled. Replays the same command before checking the current Run version.
         */
        post: operations["submitRunCommand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/commands/{commandId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read any retained command, including after disabling new command admission */
        get: operations["getRunCommand"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/controls": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Legacy lifecycle control with unchanged Run response */
        post: operations["controlRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/controls/{controlId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Legacy latest-command lookup; use commands for retained history */
        get: operations["getLatestRunControl"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/interrupt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request an interrupt for a running run */
        post: operations["interruptRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/continue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create the linked continuation run once workspace attention is cleared (design §6.5).  The original NEEDS_ATTENTION run stays terminal; the follow-up run binds the CURRENT_WORKTREE baseline with KNOWN_LINEAGE_CONTINUATION auditing and receives a system frame naming the resolved/dismissed conflict paths. */
        post: operations["continueRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Layered evidence bundle; NOT_RUN layers are never hidden */
        get: operations["getRunEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List workspace executions for a project */
        get: operations["listWorkspaceExecutions"];
        put?: never;
        /**
         * Provision a service-owned workspace execution (EW7). The source
         *     checkout must be clean; dirty WIP fails closed. The response carries
         *     a safe workspaceRef, never a filesystem path.
         */
        post: operations["createWorkspaceExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-executions/{workspaceExecutionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one workspace execution; lease expiry surfaces as leaseExpired */
        get: operations["getWorkspaceExecution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-executions/{workspaceExecutionId}/lease": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Renew the lease with fencing. A stale leaseId/fencingToken fails
         *     closed with WORKSPACE_LEASE_LOST.
         */
        post: operations["renewWorkspaceExecutionLease"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-executions/{workspaceExecutionId}/handoff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark READY_FOR_HANDOFF after re-checking target drift; a moved
         *     baseline fails closed into NEEDS_ATTENTION with an Attention item.
         */
        post: operations["handoffWorkspaceExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-executions/{workspaceExecutionId}/reclaim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Remove the worktree only with no uncommitted WIP and nothing
         *     unconsumed; otherwise fail closed and keep the worktree.
         */
        post: operations["reclaimWorkspaceExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create or idempotently return a session-owned workspace lane */
        post: operations["createWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a safe session-owned workspace lane projection */
        get: operations["getWorkspaceLane"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/bind": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bind a Run writer lease to a session-owned workspace lane */
        post: operations["bindWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reopen a retained lane for a new or resumed Run */
        post: operations["reopenWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/release": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Release a Run writer lease while retaining the lane when needed */
        post: operations["releaseWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/workspace-lanes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a remote workspace lane bound to an authorized RepositoryBinding (async) */
        post: operations["createRemoteWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-place a suspended lane at a new generation (async, generation CAS) */
        post: operations["resumeWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/suspend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop compute at a safe point while retaining the workspace (async) */
        post: operations["suspendWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/sync": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sync a clean lane to a newer base (async); P0 permits provable fast-forward only */
        post: operations["syncWorkspaceLane"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a bounded, cursored file tree page of a remote lane */
        get: operations["getWorkspaceLaneTree"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/files/{fileRef}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read bounded UTF-8 content of a lane file with its CAS version */
        get: operations["readWorkspaceLaneFile"];
        /** CAS write of a bounded text file inside a remote lane */
        put: operations["writeWorkspaceLaneFile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/git/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read branch, HEAD, base OID, ahead/behind and dirty summary of a lane */
        get: operations["getWorkspaceLaneGitStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/change-sets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Freeze the lane's current candidate into an immutable reviewable ChangeSet */
        post: operations["createWorkspaceChangeSet"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-lanes/{workspaceLaneId}/git/commits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a local Git commit from a frozen ChangeSet (async) */
        post: operations["createGitCommit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git-commits/{commitId}/publications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish a local commit OID to the service-assigned remote ref (async) */
        post: operations["createRemotePublication"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/remote-publications/{publicationId}/pull-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a provider pull/merge request for an immutable publication (async) */
        post: operations["createPullRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git-operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read progress, dispatch and effect outcome of a Git operation */
        get: operations["getGitOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git-operations/{operationId}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger server-side reconciliation; clients may not declare an outcome */
        post: operations["reconcileGitOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/git-operations/{operationId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request cancellation at the defined boundary; dispatched effects reconcile */
        post: operations["cancelGitOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create an immutable delivery candidate from a session lane */
        post: operations["createDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read an immutable delivery projection and integration state */
        get: operations["getDelivery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the frozen file diff and current target preflight */
        get: operations["getDeliveryChanges"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Capture and freeze the lane change set for review */
        post: operations["prepareDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve or reject a delivery using fingerprint and CAS guards */
        post: operations["decideDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Queue an approved delivery for serialized integration */
        post: operations["applyDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile an UNKNOWN delivery before any retry */
        post: operations["reconcileDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/deliveries/{deliveryId}/rebase": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rebase a CONFLICT/NEEDS_ATTENTION delivery candidate onto the current target
         * @description Rebuilds the frozen candidate per-path against the live target (design §6.6): clean paths keep their proposal, moved paths consume a durable conflict resolution or a deterministic three-way merge, and unresolved overlaps raise workspace-conflict/2 records.  The previous approval fingerprint is reset — a clean rebase still needs a fresh decision.
         */
        post: operations["rebaseDelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/projects/{projectId}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List delivery projections for a project */
        get: operations["listProjectDeliveries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Mission list projection for a session */
        get: operations["listMissions"];
        put?: never;
        /** Create a mission bound to a session workspace baseline */
        post: operations["createMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Mission detail with plan DAG summary and worker state */
        get: operations["getMission"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit or revise the mission plan DAG (fingerprint-guarded) */
        post: operations["planMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/approvals/{approvalId}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve or reject a mission plan revision (stale fingerprints rejected) */
        post: operations["decideMissionApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start an approved mission; the scheduler takes over */
        post: operations["startMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request a cooperative pause at the next safe checkpoint */
        post: operations["pauseMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume from the pause checkpoint (mode-guarded) */
        post: operations["resumeMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request cancellation; workers are interrupted cooperatively */
        post: operations["cancelMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/replan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit a plan revision for a mission in NEEDS_ATTENTION */
        post: operations["replanMission"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/missions/{missionId}/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Unconsumed artifact refs of a mission */
        get: operations["getMissionArtifacts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/policies/layers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Project/user/managed policy precedence projection */
        get: operations["listPolicyLayers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/policies/{layer}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Update a writable policy layer (PROJECT|USER). A candidate looser
         *     than its parent fails closed with POLICY_ELEVATION_FORBIDDEN.
         */
        put: operations["updatePolicyLayer"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/policies/effective": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Effective risk policy for a session */
        get: operations["getEffectiveRiskPolicy"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Product settings; defaults are local-only and minimal */
        get: operations["getProductSettings"];
        /** Update settings; bumps revision and emits settings.updated */
        put: operations["updateProductSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/memory/knowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Knowledge items; facts contains only CONFIRMED entries — pending
         *     suggestions never become facts.
         */
        get: operations["listKnowledge"];
        put?: never;
        /** Record a knowledge suggestion; it stays PENDING until confirmed */
        post: operations["suggestKnowledge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/memory/knowledge/{knowledgeId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm a pending suggestion; only then does it become a fact */
        post: operations["confirmKnowledge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/activities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recoverable public activity snapshot folded from the durable run event stream */
        get: operations["getRunActivities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/reasoning": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Recoverable display-reasoning snapshot folded from the run's durable
         *     run.reasoning.append stream (design 2026-09-18). Carries
         *     provider-returned public thinking text only — never answer text,
         *     tool output or continuation state. complete=false with reasonCode
         *     means the snapshot is a lower bound, never a silent truncation.
         */
        get: operations["getRunReasoning"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/output": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Recoverable visible-output snapshot folded from the run's durable
         *     run.output.append stream (design 2026-09-19 §5.5-B). Carries
         *     provider-returned public-safe output text only — never reasoning,
         *     tool output or continuation state. complete=false with reasonCode
         *     means the snapshot is a lower bound, never a silent truncation.
         */
        get: operations["getRunOutput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Paged run diff against the workspace baseline. Bounds via
         *     page/pageSize; stale when computed against an older stateVersion.
         *     Services without a persisted change artifact return a typed Problem;
         *     clients must fail closed and must not fabricate diff rows.
         */
        get: operations["getRunDiff"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/workspace-conflicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List direct-workspace CAS conflicts for a run */
        get: operations["listRunWorkspaceConflicts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/{conflictId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one direct-workspace conflict */
        get: operations["getWorkspaceConflict"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/{conflictId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve one direct-workspace conflict with optimistic concurrency */
        post: operations["resolveWorkspaceConflict"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Index-filtered conflict list (workspace-conflict/2) */
        get: operations["listWorkspaceConflicts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/{conflictId}/auto-merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recompute the three-way auto-merge preview without writing */
        post: operations["autoMergeWorkspaceConflict"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/{conflictId}/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enqueue an asynchronous AI merge proposal (read-only model call) */
        post: operations["requestWorkspaceConflictProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/proposals/{proposalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Poll an AI merge proposal job; READY carries proposalRef */
        get: operations["getWorkspaceConflictProposal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/{conflictId}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Abandon this path's proposal */
        post: operations["dismissWorkspaceConflict"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-conflicts/resolve-batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * All-or-nothing precheck then per-path apply. Applied paths are never
         *     rolled back; failures land in failedPaths with the rest pending.
         */
        post: operations["resolveWorkspaceConflictsBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-contents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Upload resolution content; returns a checksum-addressed ref */
        put: operations["putWorkspaceContent"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/workspace-contents/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a checksum-addressed blob (bounded; Range via offset/limit) */
        get: operations["getWorkspaceContent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read-only review projection with findings (empty when none) */
        get: operations["getRunReview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/findings/{findingId}/fix-task": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Turn a finding into a fix task; the finding id is preserved in the
         *     task lineage so fixes stay traceable to their review.
         */
        post: operations["createFixTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/model-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public-safe model catalog; never includes credential material */
        get: operations["getModelCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/model-catalog/authority": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * MA-001 MA04: one coherent snapshot of the model-catalog authority
         *     posture — source kind, applied release identity, enterprise sync
         *     gate/freshness state, apply-receipt state and the last typed
         *     failure. Never carries secret material; never performs a model
         *     call. LOCAL/FILE_COMPAT sources answer honestly with
         *     sync.state=NOT_APPLICABLE.
         */
        get: operations["getModelCatalogAuthority"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/agent-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public-safe user-managed specialist profile catalog */
        get: operations["listAgentProfiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sources/fetch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * EW10.2 read-only Web/issue/docs source fetch through the Java Host
         *     adapter. Content is untrusted data by definition; the endpoint is
         *     gated by the readOnlySources capability flag and bounded by hard
         *     scheme/host/size/timeout/redirect limits on the service side.
         */
        post: operations["fetchSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * EW10.3 read-only MCP source: configured servers with health status.
         *     Public-safe only — commands, arguments and environment entries never
         *     leave the service. Gated by the mcpReadOnlySource capability flag.
         */
        get: operations["listMcpServers"];
        put?: never;
        /**
         * Register an MCP server configuration (extension design §5.1). The
         *     request never carries credential material — secrets are referenced
         *     by credentialRef slot only. Starting a process is a separate,
         *     separately authorized connection action.
         */
        post: operations["registerMcpServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/resources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List resources exposed by one configured MCP server (read-only). */
        get: operations["listMcpResources"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/resources/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read one MCP resource through the Java Host adapter. Content is
         *     untrusted data by definition (design 10.6); never system authority
         *     and never written to the durable journal.
         */
        post: operations["readMcpResource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * EW10.5 skill catalog. Instructions are visible by design; the catalog
         *     never executes anything. Gated by the skillsCatalog capability flag.
         *     view=SUMMARY (extension design §9.1) returns the lightweight
         *     projection without instruction bodies for large catalogs.
         */
        get: operations["listSkills"];
        put?: never;
        /** Register a versioned, source-attributed skill. */
        post: operations["registerSkill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{skillId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enable, disable or revoke a skill with optimistic concurrency. */
        post: operations["changeSkillStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public-safe server detail; credentialRef is a slot name, never material. */
        get: operations["getMcpServer"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update mutable configuration fields. Changing executable/args/cwd/
         *     envRefs/endpoint/credentialRef increments configRevision and
         *     invalidates cached catalogs and launch approvals.
         */
        patch: operations["updateMcpServer"];
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enable or disable a server atomically with its config revision. */
        post: operations["setMcpServerStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/connection-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * CONNECT/TEST/DISCONNECT/RESTART lifecycle actions. Actions are
         *     asynchronous; poll the returned operationId. Launching a process
         *     requires the startup approval bound to the config revision.
         */
        post: operations["requestMcpConnectionAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/operations/{operationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Progress of a connection/auth operation without blocking IPC. */
        get: operations["getMcpOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Paged tool catalog of one server. Tool descriptors are cached per
         *     identity/configRevision/profile/policy revision; availability marks
         *     whether the tool is admitted to any model surface.
         */
        get: operations["listMcpServerTools"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/catalog-refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Explicit catalog refresh; may establish a connection first. */
        post: operations["refreshMcpServerCatalog"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/resource-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** M3 — resource templates exposed by the server (profile-gated). */
        get: operations["listMcpResourceTemplates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/prompts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** M3 — prompts exposed by the server (profile-gated). */
        get: operations["listMcpPrompts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/prompts/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * M3 — expand a prompt with user-confirmed arguments. The result is
         *     external content at a lower trust slot; it never auto-runs tools.
         */
        post: operations["resolveMcpPrompt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/mcp/servers/{serverId}/auth-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * M2 — START/CANCEL/REVOKE an authentication flow. The host owns the
         *     credential store; the response carries at most a user-consent URL,
         *     never tokens.
         */
        post: operations["requestMcpAuthAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{skillId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Skill definition detail: current version, version list, validation
         *     diagnostics and permission hints. Instruction bodies are fetched
         *     through the versioned manifest path, not this route.
         */
        get: operations["getSkill"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/import-sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Exchange a user-selected local root for a short-lived source handle.
         *     Only the trusted desktop main handler may call this; renderers never
         *     supply raw filesystem paths.
         */
        post: operations["createSkillImportSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/import-previews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read-only preflight of a source handle: scans SKILL.md files and the
         *     bounded file manifest without executing or copying anything.
         */
        post: operations["previewSkillImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm an import from a preview: copies the package into the
         *     host-private immutable store under its packageDigest and registers
         *     the version transactionally. Re-import of the same digest is
         *     idempotent.
         */
        post: operations["importSkillPackage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{skillId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Immutable version list of one skill. */
        get: operations["listSkillVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{skillId}/versions/{versionDigest}/manifest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * File manifest of one immutable version. Paths are package-relative;
         *     host storage locations are never exposed.
         */
        get: operations["getSkillVersionManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/skills/{skillId}/current-version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Switch the version new executions see. Running executions keep their
         *     frozen digest; permission-hint changes are called out explicitly.
         */
        post: operations["selectSkillVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/extension-test-executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Explicit extension debug/test execution context (extension design
         *     §9.1). Test invocations share the same governance, approval and
         *     evidence pipeline as real task executions.
         */
        post: operations["createExtensionTestExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/executions/{executionId}/extensions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Binding, activation and context-manifest evidence of one execution
         *     (workspace run or plain chat). Proves which content entered which
         *     model request; never claims the model obeyed it.
         */
        get: operations["getExecutionExtensions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/executions/{executionId}/extension-invocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Paged invocation list of one execution. UNKNOWN rows mean the
         *     external effect could not be confirmed — they are never retried
         *     silently.
         */
        get: operations["listExecutionExtensionInvocations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/executions/{executionId}/extension-invocations/{invocationId}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Execution-level recovery action on one governed invocation
         *     (extension design §10.1): CANCEL settles the row with the honest
         *     effect outcome and emits the wire cancellation for the exact
         *     request; RESUME_INPUT answers a parked WAITING_INPUT (MRTR) call on
         *     the same logical invocation; RECONCILE re-reads the durable row and
         *     its attempt evidence for a human decision — it never re-sends the
         *     wire request.
         */
        post: operations["runExtensionInvocationAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hooks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * EW10.6 typed hooks: operator-allowlisted lifecycle observers with
         *     health status. Command material never leaves the service. Gated by
         *     the hooks capability flag.
         */
        get: operations["listHooks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hooks/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Bounded recent hook executions (status and duration only). */
        get: operations["listHookExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * WU01 (uplift design §5): list Hub association records. Public-safe
         *     only — credential material never leaves the service; the record
         *     carries the credential slot flag, never the value.
         */
        get: operations["listHubConnections"];
        put?: never;
        /**
         * Register a Hub association (uplift design §5). The base URL is
         *     fixed for the life of the record — re-pointing means registering a
         *     new connection. Plain HTTP requires an explicit loopback opt-in;
         *     remote Hubs require HTTPS and a credentialRef slot.
         */
        post: operations["registerHubConnection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Hub connection detail (WU01). */
        get: operations["getHubConnection"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update display name, credential slot, insecure-loopback flag or
         *     enabled state under expectedRevision CAS. baseUrl is immutable.
         */
        patch: operations["updateHubConnection"];
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/connection-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * CONNECT / TEST / DIAGNOSE probe the Hub through the typed client
         *     (/healthz + /api/v1/info + /api/v1/capabilities) and persist the
         *     observed identity; DISCONNECT marks the association stopped. This
         *     is not a model-addressable proxy — the allowlisted endpoints are
         *     the only ones reachable.
         */
        post: operations["requestHubConnectionAction"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/register-server": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Materialize (or reuse) the managed MCP server row pointing at the
         *     Hub's /mcp endpoint. The row is stamped connectionMode=HUB so
         *     bindings mark the real source. Requires a READY association.
         */
        post: operations["registerHubManagedServer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Live catalog probe: GET /api/v1/capabilities on the associated Hub
         *     through the typed client. Read-only; does not mutate the record.
         */
        get: operations["getHubCapabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/resources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Passthrough to the Hub's GET /api/v2/resources — per-resourceKey
         *     occupancy (free | session | call) for the associated Hub. The Hub
         *     owns the payload schema; the service proxies it verbatim.
         */
        get: operations["listHubResources"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Passthrough to the Hub's GET /api/v2/resources/sessions — known
         *     control leases on the associated Hub (Hub-owned schema).
         */
        get: operations["listHubSessions"];
        put?: never;
        /**
         * Passthrough to the Hub's POST /api/v2/resources/sessions — acquire
         *     a single-controller lease over a resourceKey. Body is Hub-owned:
         *     {resourceKey, mode: managed|attached, controller, ttlSeconds}.
         */
        post: operations["acquireHubSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Passthrough to the Hub's GET /api/v2/resources/sessions/{id} —
         *     one lease view with state/controlEpoch/controller.
         */
        get: operations["getHubSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/hub/connections/{hubConnectionId}/sessions/{sessionId}/control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Passthrough to the Hub's POST /api/v2/resources/sessions/{id}/control
         *     — lease actions pause|resume|handover|estop|release|renew with
         *     optional expectedEpoch CAS. Handover marks the controller human
         *     and invalidates the previous epoch; estop also cancels bound
         *     running calls. The response carries the authoritative session
         *     state — the UI must adopt control state only from this receipt.
         */
        post: operations["controlHubSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/context-packages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createContextPackage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/context-packages/{pid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getContextPackage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/context-packages/{pid}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getContextPackageItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/auxiliary-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAuxiliarySessions"];
        put?: never;
        post: operations["createAuxiliarySession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{auxId}/auxiliary-turns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAuxiliaryTurns"];
        put?: never;
        post: operations["submitAuxiliaryTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{auxId}/auxiliary-turns/{tid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAuxiliaryTurn"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{auxId}/auxiliary-turns/{tid}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelAuxiliaryTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/boundary-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listBoundaryInputs"];
        put?: never;
        post: operations["submitBoundaryInput"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/boundary-requests/{bid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBoundaryInput"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/boundary-requests/{bid}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelBoundaryInput"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/assignment-transitions/preflight": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["preflightAssignmentTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/assignment-transitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAssignmentTransitions"];
        put?: never;
        post: operations["submitAssignmentTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/assignment-transitions/{hid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAssignmentTransition"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/assignment-transitions/{hid}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelAssignmentTransition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{rid}/execution-segments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExecutionSegments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/worker-execution-window": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWorkerExecutionWindow"];
        put?: never;
        post: operations["publishWorkerExecutionWindow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** listWritableCollaborationGroups */
        get: operations["listWritableCollaborationGroups"];
        put?: never;
        /** createWritableCollaborationGroup */
        post: operations["createWritableCollaborationGroup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritableCollaborationGroup */
        get: operations["getWritableCollaborationGroup"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** authorizeWritableCollaborationGroup */
        post: operations["authorizeWritableCollaborationGroup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** startWritableCollaborationGroup */
        post: operations["startWritableCollaborationGroup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** cancelWritableCollaborationGroup */
        post: operations["cancelWritableCollaborationGroup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/selections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** selectWritableCandidates */
        post: operations["selectWritableCandidates"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/adoptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** listWritableAdoptions */
        get: operations["listWritableAdoptions"];
        put?: never;
        /** adoptWritablePreview */
        post: operations["adoptWritablePreview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/executions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** listWritableExecutions */
        get: operations["listWritableExecutions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/executions/{executionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritableExecution */
        get: operations["getWritableExecution"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/executions/{executionId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** cancelWritableExecution */
        post: operations["cancelWritableExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/executions/{executionId}/rework": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** reworkWritableExecution */
        post: operations["reworkWritableExecution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/candidates/{candidateId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritableCandidate */
        get: operations["getWritableCandidate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/candidates/{candidateId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritableCandidateFiles */
        get: operations["getWritableCandidateFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/selections/{selectionId}/previews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** previewWritableSelection */
        post: operations["previewWritableSelection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/previews/{previewId}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** reviseWritablePreview */
        post: operations["reviseWritablePreview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/previews/{previewId}/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** reviewWritablePreview */
        post: operations["reviewWritablePreview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/reviews/{reviewId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritablePreviewReview */
        get: operations["getWritablePreviewReview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/adoptions/{adoptionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getWritableAdoption */
        get: operations["getWritableAdoption"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/adoptions/{adoptionId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** cancelWritableAdoption */
        post: operations["cancelWritableAdoption"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/adoptions/{adoptionId}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** recoverWritableAdoption */
        post: operations["recoverWritableAdoption"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/adoptions/{adoptionId}/repairs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** startIsolatedWritableRepair */
        post: operations["startIsolatedWritableRepair"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** getCollaborationAttemptActivity */
        get: operations["getCollaborationAttemptActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/previews/{previewId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read bounded immutable B/C/P and integration bytes */
        get: operations["getWritablePreviewFiles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/sessions/{sid}/worker-execution-window/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Registered WORKER only. Irreversibly closes forward intake on the exact original binding, command and deadline. Replays retain CLOSING; query and STOP remain available. */
        post: operations["closeWorkerExecutionWindow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Registered WORKER only. Requires original window CLOSING and proven actual producer quiescence. Pins sources before copy; exact exportId replays the original immutable cut. */
        post: operations["exportCollaborationFinalEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-evidence/{exportId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCollaborationFinalEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-evidence/{exportId}/bytes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Registered WORKER only. Reads at most 65536 bytes as base64 with exact offset, nextOffset, digest and total size. GET has no execution or acknowledgement effects. */
        get: operations["readCollaborationFinalEvidenceBytes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-evidence/{exportId}/upload-ack": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Registered WORKER only, after actual artifact upload receipt. Key is ack-{exportId}; all digest, size, artifact and receipt fields must match on replay. Releases export source pins. */
        post: operations["acknowledgeCollaborationEvidenceUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/runs/{runId}/collaboration-groups/{groupId}/repairs/{repairId}/recover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Observe and reconcile the original isolated repair without another model execution
         * @description Explicit exact-revision action; GET remains read-only. Requires proven original coordinator/producer stop. Reuses only the original dispatch, sealed stage, grant and budget. Never starts a second repair. Parent adoption requires separate current authority.
         */
        post: operations["recoverOriginalCollaborationRepair"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        CollaborationEvidenceExportRequest: {
            /** @enum {string} */
            schemaVersion: "collaboration-evidence-export-request/1";
            exportId: string;
        };
        CollaborationEvidenceUploadAck: {
            /** @enum {string} */
            schemaVersion: "collaboration-evidence-upload-ack/1";
            exportId: string;
            digest: string;
            manifestDigest: string;
            sizeBytes: string;
            artifactId: string;
            receiptRef: string;
        };
        ContextPackageRequest: {
            /**
             * @default context-package-request/1
             * @enum {string}
             */
            schemaVersion: "context-package-request/1";
            requestId: string;
            /**
             * @default OBSERVE
             * @enum {string}
             */
            profile: "OBSERVE" | "RESEARCH";
            snapshotId: string;
        };
        AuxiliarySessionRequest: {
            /**
             * @default auxiliary-session-create/1
             * @enum {string}
             */
            schemaVersion: "auxiliary-session-create/1";
            requestId: string;
            /**
             * @default SIDECAR_QUESTION
             * @enum {string}
             */
            purpose: "SIDECAR_QUESTION" | "DELEGATE_READ_ONLY";
            basePackageId: string;
            title?: string;
        };
        AuxiliaryResearchTask: {
            taskId: string;
            /** @enum {string} */
            role: "repo-explorer" | "dependency-tracer" | "test-impact-reviewer" | "risk-reviewer";
            question: string;
        };
        AuxiliaryTurnRequest: {
            /**
             * @default auxiliary-turn/1
             * @enum {string}
             */
            schemaVersion: "auxiliary-turn/1";
            turnId: string;
            expectedSessionVersion: string;
            packageId: string;
            question: string;
            modelAlias?: string;
            retryOfTurnId?: string;
            /** @default false */
            textOnlyResearch: boolean;
            researchTasks?: components["schemas"]["AuxiliaryResearchTask"][];
        };
        BoundaryInputRequest: {
            /**
             * @default run-boundary-request/1
             * @enum {string}
             */
            schemaVersion: "run-boundary-request/1";
            requestId: string;
            /** @enum {string} */
            kind: "REQUEST_REPORT" | "CONTEXT_ADVICE";
            expectedExecutionEpoch: string;
            text: string;
            sourceRefs?: string[];
        };
        AssignmentModelSelection: {
            /**
             * @default KEEP_EFFECTIVE
             * @enum {string}
             */
            mode: "KEEP_EFFECTIVE" | "EXPLICIT";
            settings?: components["schemas"]["SessionModelSettings"];
        };
        AssignmentTarget: {
            /**
             * @default product-code
             * @enum {string}
             */
            harnessId: "product-code";
            agentProfileId: string;
            agentProfileRevision: string;
            modelSelection?: components["schemas"]["AssignmentModelSelection"];
        };
        AssignmentTransitionRequest: {
            /**
             * @default assignment-transition-request/1
             * @enum {string}
             */
            schemaVersion: "assignment-transition-request/1";
            transitionId?: string;
            expectedRunStateVersion?: string;
            expectedExecutionEpoch?: string;
            expectedModelSettingsRevision?: string;
            preflightDigest?: string;
            target: components["schemas"]["AssignmentTarget"];
            /**
             * @default CANCEL_PENDING
             * @enum {string}
             */
            pendingInputPolicy: "CANCEL_PENDING" | "RETAIN_PENDING";
        };
        WorkerExecutionWindowRequest: {
            /** @enum {string} */
            schemaVersion: "worker-execution-window/1";
            runCommandId: string;
            deadlineEpochMillis: string;
            executionBinding: components["schemas"]["WorkerSessionBinding"];
        };
        CollaborationResource: {
            schemaVersion?: string;
            state?: string;
            sessionId?: string;
            parentSessionId?: string;
            runId?: string;
            packageId?: string;
            digest?: string;
            turnId?: string;
            jobId?: string;
            transitionId?: string;
            requestId?: string;
            answer?: string;
            executionEpoch?: string;
            sessionVersion?: string;
            preflightDigest?: string;
            runStateVersion?: string;
            modelSettingsRevision?: string;
            reasonCode?: string | null;
        } & {
            [key: string]: unknown;
        };
        ClientRegistrationRequest: {
            /** Format: uuid */
            registrationKey: string;
            /** Format: uuid */
            clientId: string;
            /** Format: uuid */
            processInstanceId: string;
            /** @enum {string} */
            clientKind: "ELECTRON" | "WEB_TAB" | "CLI" | "SWING" | "WORKER" | "MOBILE";
            protocols: string[];
            displayLabel?: string;
        };
        ClientSessionResponse: {
            /** Format: uuid */
            clientSessionId: string;
            clientSessionToken: string;
            storeId: string;
            /** Format: uuid */
            bootId: string;
            /** Format: int64 */
            ttlMillis: number;
            /** Format: int64 */
            remainingTtlMillis: number;
            replay?: boolean;
            acceptedProtocols: string[];
        };
        ClientSessionSummaryResponse: {
            /** Format: uuid */
            clientSessionId: string;
            principalId: string;
            /** Format: uuid */
            clientId: string;
            clientKind: string;
            acceptedProtocols: string[];
            displayLabel?: string;
            /** Format: int64 */
            createdAtMillis: number;
            /** Format: int64 */
            lastHeartbeatAtMillis: number;
            /** Format: int64 */
            expiresAtMillis: number;
            /** @enum {string} */
            state: "ACTIVE";
        };
        ClientHeartbeatResponse: {
            /** Format: uuid */
            clientSessionId: string;
            /** Format: int64 */
            serverTimeMillis: number;
            /** Format: int64 */
            remainingTtlMillis: number;
        };
        OperationLookupRequest: {
            operation: string;
            resourceId: string;
            idempotencyKey: string;
        };
        OperationReceiptResponse: {
            receiptId: string;
            operation: string;
            resourceId: string;
            /** @enum {string} */
            status: "APPLIED" | "PENDING" | "NOT_APPLIED" | "UNKNOWN";
            requestHash: string;
            /** Format: int64 */
            createdAtMillis: number;
            result?: {
                [key: string]: unknown;
            } | null;
        };
        EventSnapshotResponse: {
            /** @enum {string} */
            consistency: "RESOURCE_VERSIONED";
            events: {
                [key: string]: unknown;
            }[];
            /** Format: int64 */
            nextCursor: number;
            /** Format: int64 */
            scannedThroughCursor: number;
            /** Format: int64 */
            highWaterMark: number;
            /** Format: int64 */
            retentionFloor: number;
            /** Format: int64 */
            snapshotCursor: number;
            nextPageToken?: string | null;
            /** Format: int64 */
            expiresAt: number;
            complete: boolean;
            truncated: boolean;
            responseBytes: number;
        };
        ExecutionPolicyResponse: {
            schemaVersion?: string;
            principalId: string;
            projectId: string;
            /** Format: int64 */
            revision: number;
            /** @enum {string} */
            mode: "STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS";
            /** @enum {string} */
            managedModeCeiling: "STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS";
            supportedModes: ("STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS")[];
            /** Format: int64 */
            routineDelayMillis: number;
            /** Format: int64 */
            planDelayMillis: number;
            budgetDelayMillis: number[];
            maxAutomaticBudgetApprovals: number;
            /** Format: int64 */
            approvalTtlMillis: number;
            fullAccessConfirmed: boolean;
            policyFingerprint: string;
            /** @enum {string} */
            scopeType?: "SESSION" | "PROJECT" | "USER";
            scopeId?: string;
            /** @enum {string} */
            requestedMode?: "STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS";
            /** @enum {string} */
            effectiveMode?: "STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS";
            /** @description FULL_ACCESS grant semantics generation (1=legacy confirmed, 2=direct grant). */
            permissionSemanticsVersion?: number;
            /**
             * @description Frontend rendering hint: ALLOW_ALL only while a live FULL_ACCESS grant governs the scope.
             * @enum {string}
             */
            approvalBehavior?: "MANUAL" | "DELAYED" | "ALLOW_ALL";
            policySource?: string;
            /** Format: int64 */
            grantRevision?: number;
            grantSource?: string;
            /** Format: date-time */
            grantedAt?: string;
            grantActor?: string;
            /** @description ACTIVE when the grant is usable; BLOCKED/INACTIVE otherwise. */
            activationStatus?: string;
            blockingReasons?: string[];
            /**
             * Format: int64
             * @description Count of pending approvals re-decided by a RECONCILE_SESSION update.
             */
            reconciledPendingApprovals?: number;
            /** Format: date-time */
            serverTime: string;
        };
        ExecutionPolicyUpdateRequest: {
            /** Format: int64 */
            expectedRevision: number;
            /** @enum {string} */
            requestedMode?: "STANDARD" | "AUTO_APPROVE" | "FULL_ACCESS";
            /** Format: int64 */
            routineDelayMillis?: number;
            /** Format: int64 */
            planDelayMillis?: number;
            budgetDelayMillis?: number[];
            maxAutomaticBudgetApprovals?: number;
            /** Format: int64 */
            approvalTtlMillis?: number;
            acknowledgementVersion?: string;
            /** @default false */
            fullAccessConfirmation: boolean;
            /** @description Grant semantics generation. 2 = selecting FULL_ACCESS is itself the grant (no second confirmation); absent keeps the stored generation. Legacy semantics-1 updates still require fullAccessConfirmation + acknowledgementVersion. */
            permissionSemanticsVersion?: number;
            /**
             * @description RETAIN keeps existing waiting approvals untouched (default); RECONCILE_SESSION re-evaluates this scope's pending approvals under the new grant.
             * @enum {string}
             */
            pendingApprovalAction?: "RETAIN" | "RECONCILE_SESSION";
            applyToPendingApprovalIds?: string[];
        };
        AutomationControlRequest: {
            /** Format: int64 */
            expectedVersion: number;
            /** @enum {string} */
            control: "PAUSE_AUTOMATION" | "RESUME_AUTOMATION";
        };
        AutomationControlResponse: {
            schemaVersion: string;
            principalId: string;
            sessionId: string;
            paused: boolean;
            /** Format: int64 */
            version: number;
            /** Format: int64 */
            updatedAtMillis: number;
            /** Format: date-time */
            serverTime: string;
        };
        ApprovalRequestV2: {
            approvalId: string;
            sessionId: string;
            runId: string;
            agentId: string;
            /** @enum {string} */
            kind: "COMMAND" | "WRITE" | "BUDGET" | "SANDBOX" | "SPEC" | "PLAN" | "REPLAN" | "EXTENSION" | "UNKNOWN";
            domainRef: string;
            /** Format: int64 */
            domainVersion: number;
            /** Format: int64 */
            requestVersion: number;
            decisionStatus: string;
            executionStatus: string;
            requestFingerprint: string;
            policyFingerprint: string;
            /** Format: int64 */
            grantRevision: number;
            /** @enum {string} */
            riskCategory: "NONE" | "UNCLASSIFIED" | "D1_IRRECOVERABLE_USER_DATA_LOSS" | "D2_SHARED_OR_PRODUCTION_DESTRUCTION" | "D3_SENSITIVE_DISCLOSURE_OR_SECURITY_BOUNDARY" | "D4_IRREVERSIBLE_EXTERNAL_COMMIT";
            riskEvidence?: string[];
            publicSummary: string;
            /** Format: date-time */
            autoApproveAt?: string | null;
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            serverTime: string;
            allowedActions: ("APPROVE" | "EXECUTE" | "DENY" | "CANCEL" | "ADVANCE" | "PAUSE_DELAY" | "RESUME_DELAY")[];
            /** Format: int64 */
            version: number;
            decision?: string | null;
            decisionSource?: string | null;
            /** @description True only when the record waits on an interactive human decision; automatically-approved or terminal records serialize false so clients never surface false reminders. */
            requiresUserAction?: boolean;
        };
        ApprovalListResponse: {
            items: components["schemas"]["ApprovalRequestV2"][];
            /** Format: date-time */
            serverTime: string;
            /** Format: int64 */
            projectionVersion: number;
            nextCursor?: string | null;
        };
        ApprovalDecisionRequest: {
            /** Format: int64 */
            expectedVersion: number;
            fingerprint?: string | null;
            requestFingerprint?: string | null;
            /** @enum {string} */
            decision: "APPROVE" | "DENY" | "REJECT" | "CANCEL" | "EXECUTE";
        };
        ApprovalAdvanceRequest: {
            /** Format: int64 */
            expectedVersion: number;
            fingerprint?: string | null;
            requestFingerprint?: string | null;
            /** @enum {string|null} */
            control?: "PAUSE_DELAY" | "RESUME_DELAY" | "CANCEL" | null;
        };
        TerminalSessionCreateRequest: {
            workspaceExecutionId: string;
            createdByRunId?: string | null;
            /** @enum {string} */
            profile?: "DIRECT_PROCESS" | "USER_SHELL" | "AGENT_SHELL" | "DEBUGGER_CLI";
            executable: string;
            arguments?: string[];
            workingDirectory?: string;
            columns?: number;
            rows?: number;
            /** @enum {string} */
            lifetimeScope?: "RUN" | "SESSION" | "WORKSPACE";
            /** @enum {string} */
            inputPolicy?: "NONE" | "BOUNDED_TEXT" | "RAW" | "USER_ONLY";
            /** @enum {string} */
            terminalMode?: "LINE_STREAM" | "FULL_VT";
            /** @enum {string} */
            networkIntent?: "INHERIT" | "DENY" | "ALLOW";
            /** Format: int64 */
            maxLifetimeMillis?: number;
            workspaceLineageId?: string | null;
            leaseId?: string | null;
        };
        TerminalAllowedActions: {
            canReadOutput: boolean;
            canWriteInput: boolean;
            canResize: boolean;
            canInterrupt: boolean;
            canTerminate: boolean;
            canClose: boolean;
            canAgentWrite: boolean;
            canUserWrite: boolean;
        };
        TerminalSessionResponse: {
            terminalSessionId: string;
            businessSessionId: string;
            workspaceExecutionId?: string | null;
            createdByRunId?: string | null;
            serviceInstanceId: string;
            /** @enum {string} */
            state: "PENDING_APPROVAL" | "STARTING" | "RUNNING" | "INTERRUPTING" | "EXITED" | "TERMINATING" | "TERMINATED" | "FAILED" | "LOST" | "CLOSED";
            /** Format: int64 */
            stateVersion: number;
            /** @enum {string} */
            lifetimeScope: "RUN" | "SESSION" | "WORKSPACE";
            /** @enum {string} */
            profile: "DIRECT_PROCESS" | "USER_SHELL" | "AGENT_SHELL" | "DEBUGGER_CLI";
            /** @enum {string} */
            terminalMode: "LINE_STREAM" | "FULL_VT";
            /** @enum {string} */
            inputPolicy: "NONE" | "BOUNDED_TEXT" | "RAW" | "USER_ONLY";
            /** @enum {string} */
            controller: "NONE" | "USER" | "AGENT";
            columns: number;
            rows: number;
            outputCursor?: string | null;
            /** Format: int64 */
            outputBytes: number;
            /** Format: int64 */
            inputVersion: number;
            /** Format: date-time */
            startedAt?: string | null;
            /** Format: date-time */
            lastActivityAt?: string | null;
            /** Format: date-time */
            expiresAt?: string | null;
            exitCode?: number | null;
            terminalCause?: string | null;
            /** @enum {string} */
            controlState: "FREE" | "ACTIVATING" | "HELD" | "RELEASING" | "RECONCILE_REQUIRED" | "CLOSED";
            /** Format: int64 */
            controlVersion: number;
            /** Format: int64 */
            controlEpoch: number;
            canAcquire: boolean;
            canInput: boolean;
            safeHolderLabel?: string | null;
            /** Format: int64 */
            remainingControlTtlMillis: number;
            allowedActions: components["schemas"]["TerminalAllowedActions"];
        };
        /** @enum {string} */
        TerminalOutputMode: "RAW_VT" | "PLAIN_TEXT";
        TerminalOutputResponse: {
            terminalSessionId: string;
            startCursor?: string | null;
            nextCursor?: string | null;
            /** Format: int64 */
            startOffset: number;
            /** Format: int64 */
            endOffset: number;
            dataBase64?: string | null;
            plainText?: string | null;
            mode: components["schemas"]["TerminalOutputMode"];
            state: string;
            eof: boolean;
            historyIncomplete: boolean;
            gap: boolean;
            serviceInstanceId: string;
        };
        TerminalInputRequest: {
            operationId: string;
            /** Format: int64 */
            expectedStateVersion: number;
            /** Format: int64 */
            expectedInputVersion: number;
            /** @enum {string} */
            encoding?: "UTF8" | "BASE64";
            text?: string | null;
            dataBase64?: string | null;
            /**
             * @deprecated
             * @enum {string|null}
             */
            controller?: "USER" | "AGENT" | null;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
        };
        TerminalInputResponse: {
            operationId: string;
            /** Format: int64 */
            inputVersion: number;
            /** @enum {string} */
            delivery: "PENDING" | "APPLIED" | "UNKNOWN" | "REJECTED";
        };
        TerminalResizeRequest: {
            operationId: string;
            /** Format: int64 */
            expectedStateVersion: number;
            columns: number;
            rows: number;
            /** Format: int64 */
            resizeSequence: number;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
        };
        TerminalResizeResponse: {
            columns: number;
            rows: number;
            /** Format: int64 */
            resizeSequence: number;
        };
        TerminalSignalRequest: {
            operationId: string;
            /** Format: int64 */
            expectedStateVersion: number;
            /** @enum {string} */
            signal: "INTERRUPT" | "TERMINATE" | "KILL";
            /** Format: int64 */
            graceMillis?: number;
            forceAfterGrace?: boolean;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
        };
        TerminalSignalResponse: {
            signal: string;
            /** @enum {string} */
            delivery: "PENDING" | "APPLIED" | "UNKNOWN" | "REJECTED";
            /** Format: int64 */
            stateVersion: number;
            accepted: boolean;
        };
        TerminalCloseResponse: {
            accepted: boolean;
            finalState: string;
        };
        TerminalCloseRequest: {
            operationId: string;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
            /** Format: int64 */
            expectedStateVersion: number;
        };
        TerminalControlAcquireRequest: {
            operationId: string;
            /** Format: int64 */
            expectedControlVersion: number;
        };
        TerminalControlRenewRequest: {
            operationId: string;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
            /** Format: int64 */
            expectedControlVersion: number;
        };
        TerminalControlReleaseRequest: {
            operationId: string;
            leaseId: string;
            /** Format: int64 */
            controlEpoch: number;
            /** Format: int64 */
            expectedControlVersion: number;
        };
        TerminalControlResponse: {
            terminalSessionId: string;
            /** @enum {string} */
            state: "FREE" | "ACTIVATING" | "HELD" | "RELEASING" | "RECONCILE_REQUIRED" | "CLOSED";
            /** Format: int64 */
            controlVersion: number;
            /** Format: int64 */
            controlEpoch: number;
            leaseId?: string | null;
            /** Format: int64 */
            remainingTtlMillis: number;
            canInput: boolean;
            leaseCurrentlyValid: boolean;
            safeHolderLabel?: string | null;
            /** Format: int64 */
            terminalStateVersion: number;
            /** @enum {string} */
            delivery: "APPLIED" | "REPLAY" | "NOT_APPLIED" | "UNKNOWN";
        };
        DiffPageResponse: {
            runId: string;
            /** Format: int64 */
            stateVersion: number;
            artifactId?: string | null;
            baselineFingerprint?: string | null;
            endFingerprint?: string | null;
            /** @description Immutable Business-owned baseline content manifest reference. */
            baselineContentManifestRef?: string | null;
            /** @description Immutable Business-owned terminal content manifest reference. */
            endContentManifestRef?: string | null;
            /** @enum {string|null} */
            deltaSemantic?: "START_CONTENT_TO_END_CONTENT" | null;
            complete?: boolean;
            baseRevision?: string | null;
            incompleteReason?: string | null;
            stale?: boolean;
            truncated?: boolean;
            page?: number;
            pageSize?: number;
            hasMore?: boolean;
            files: {
                path?: string;
                /** @enum {string} */
                changeType?: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";
                binary?: boolean;
                patch?: string | null;
                truncated?: boolean;
            }[];
        };
        ReviewRunResponse: {
            reviewId: string;
            runId: string;
            /** Format: int64 */
            stateVersion?: number;
            status?: string | null;
            complete?: boolean;
            sourceArtifactId?: string | null;
            reportArtifactId?: string | null;
            /** @enum {string|null} */
            reportStatus?: "PARTIAL" | "AVAILABLE" | null;
            reportContent?: string | null;
            reportSha256?: string | null;
            reportComplete?: boolean;
            findings: {
                findingId?: string;
                severity?: string | null;
                file?: string | null;
                line?: number | null;
                message?: string | null;
                fixTaskId?: string | null;
            }[];
        };
        FixTaskResponse: {
            taskId: string;
            taskFingerprint?: string | null;
            findingId: string;
        };
        /** @enum {string} */
        WorkspaceMode: "AUTO" | "ISOLATED_WORKTREE" | "LOCAL_CHECKOUT" | "READ_ONLY_SNAPSHOT";
        /** @enum {string} */
        WorkspaceStartPolicy: "CLEAN_HEAD" | "USER_WIP_SNAPSHOT" | "APPROVED_DELIVERY" | "FORK_SNAPSHOT";
        WorkspacePolicy: {
            mode?: components["schemas"]["WorkspaceMode"];
            startPolicy?: components["schemas"]["WorkspaceStartPolicy"];
            expectedBaseRevision?: string | null;
            preflightRevision?: string | null;
            pinLane?: boolean | null;
            baseSnapshotFingerprint?: string | null;
            baseSnapshotId?: string | null;
            wipAllowPrefixes?: string[];
        };
        WorkspaceBindingResponse: {
            workspaceLaneId?: string;
            workspaceExecutionId?: string;
            workspaceRef?: string | null;
            mode?: components["schemas"]["WorkspaceMode"];
            baseRevision?: string | null;
            baseSource?: string | null;
            state?: string | null;
            integrationState?: string | null;
            latestDeliveryId?: string | null;
            /** Format: int64 */
            stateVersion?: number | null;
        };
        WorkspaceConflictResponse: {
            /** @default workspace-conflict/2 */
            schemaVersion: string;
            conflictId: string;
            origin?: string | null;
            originRef?: {
                runId?: string | null;
                deliveryId?: string | null;
                laneId?: string | null;
                syncSessionId?: string | null;
                /** Format: int64 */
                revision?: number | null;
            } | null;
            projectId?: string | null;
            endpointId?: string | null;
            runId: string;
            sessionId?: string | null;
            path: string;
            kind?: string | null;
            expectedVersion?: string | null;
            actualVersion?: string | null;
            /** @enum {string} */
            state: "OPEN" | "RESOLVING" | "RESOLVED" | "DISMISSED" | "STALE";
            /** Format: int64 */
            stateVersion: number;
            /** @description Bounded current file preview */
            currentContent?: string | null;
            /** @description Optional retained proposal preview */
            proposedContent?: string | null;
            resolutionRef?: string | null;
            baseVersionToken?: string | null;
            baseContentRef?: string | null;
            currentContentRef?: string | null;
            proposedContentRef?: string | null;
            /** Format: int64 */
            proposedByteLength?: number | null;
            blobStoreRef?: string | null;
            base?: {
                ref?: string | null;
                version?: string | null;
            } | null;
            current?: {
                ref?: string | null;
                version?: string | null;
            } | null;
            proposed?: {
                ref?: string | null;
                version?: string | null;
            } | null;
            autoMerge?: {
                status?: string | null;
                previewRef?: string | null;
                reason?: string | null;
            } | null;
            allowedActions?: string[];
            resolution?: {
                choice?: string | null;
                resultRef?: string | null;
                resolvedBy?: string | null;
                resolvedAt?: string | null;
                appliedOperationId?: string | null;
            } | null;
            limits?: {
                /** Format: int64 */
                maxContentBytes?: number;
                previewTruncated?: boolean | null;
            } | null;
        };
        WorkspaceConflictListResponse: {
            runId: string;
            items: components["schemas"]["WorkspaceConflictResponse"][];
        };
        WorkspaceConflictResolveRequest: {
            /**
             * Format: int64
             * @default 0
             */
            expectedStateVersion: number;
            expectedCurrentHash?: string | null;
            /** @enum {string} */
            choice: "KEEP_CURRENT" | "USE_PROPOSED" | "MERGED_CONTENT" | "AUTO_MERGED" | "DISMISS";
            /** @description Required for USE_PROPOSED or MERGED_CONTENT when the proposal is not retained */
            resolutionContent?: string | null;
            /** @description blob:sha256 ref from a prior workspace-contents upload */
            resolutionRef?: string | null;
            operationId?: string | null;
        };
        WorkspaceConflictResolveBatchRequest: {
            syncSessionId?: string | null;
            items: {
                conflictId: string;
                /**
                 * Format: int64
                 * @default 0
                 */
                expectedStateVersion: number;
                expectedCurrentHash?: string | null;
                /** @enum {string} */
                choice: "KEEP_CURRENT" | "USE_PROPOSED" | "MERGED_CONTENT" | "AUTO_MERGED" | "DISMISS";
                resolutionContent?: string | null;
                resolutionRef?: string | null;
            }[];
        };
        WorkspaceContentsResponse: {
            ref: string;
            sha256: string;
            /** Format: int64 */
            byteLength: number;
        };
        WorkspaceLaneCreateRequest: {
            sessionId: string;
            projectId: string;
            baselineRevision?: string | null;
            /** @enum {string|null} */
            startPolicy?: "CLEAN_HEAD" | "USER_WIP_SNAPSHOT" | "APPROVED_DELIVERY" | "FORK_SNAPSHOT" | null;
            wipSnapshotId?: string | null;
            baseSnapshotFingerprint?: string | null;
            allowPrefixes?: string[];
        };
        WorkspaceLaneBindRequest: {
            sessionId: string;
            runId: string;
            /** Format: int64 */
            expectedStateVersion?: number | null;
        };
        WorkspaceLaneReopenRequest: {
            sessionId: string;
            runId: string;
            /** Format: int64 */
            expectedStateVersion?: number | null;
        };
        WorkspaceLaneReleaseRequest: {
            sessionId: string;
            runId: string;
            leaseId: string;
            /** Format: int64 */
            fencingToken: number;
            /** Format: int64 */
            expectedStateVersion?: number | null;
        };
        WorkspaceLaneResponse: {
            workspaceLaneId: string;
            projectId: string;
            /** @enum {string} */
            ownerType: "SESSION";
            ownerId: string;
            mode: components["schemas"]["WorkspaceMode"];
            baseSource?: string | null;
            baseRevision?: string | null;
            baseSnapshotFingerprint?: string | null;
            workspaceExecutionId?: string | null;
            /** Format: int64 */
            executionGeneration?: number | null;
            workspaceRef?: string | null;
            state: string;
            integrationState?: string | null;
            environmentNamespace?: string | null;
            latestDeliveryId?: string | null;
            pinned?: boolean | null;
            /** Format: int64 */
            stateVersion: number;
            repositoryId?: string | null;
            baseRef?: string | null;
            baseOid?: components["schemas"]["GitOid"];
            workingRef?: string | null;
            headOid?: components["schemas"]["GitOid"];
            executionTarget?: string | null;
            durability?: components["schemas"]["LaneDurabilityState"];
            dirtyFileCount?: number | null;
            latestChangeSetId?: string | null;
            latestGitCommitId?: string | null;
            latestPublicationId?: string | null;
            attentionReason?: string | null;
            activePlacement?: {
                placementId?: string | null;
                /** Format: int64 */
                generation?: number | null;
                runtimeWorkspaceRef?: string | null;
                state?: string | null;
                health?: string | null;
                leaseUntil?: string | null;
            } | null;
        };
        /** @enum {string} */
        GitObjectFormat: "SHA1" | "SHA256";
        GitOid: {
            algorithm: components["schemas"]["GitObjectFormat"];
            /** @description Full-length lower-case object id; short display forms are never accepted */
            hex: string;
        };
        /** @enum {string} */
        RemoteLaneState: "REQUESTED" | "WAITING_CAPACITY" | "FETCHING" | "MATERIALIZING" | "READY" | "IN_USE" | "DIRTY" | "COMMITTING" | "COMMITTED" | "PUBLISHING" | "PUBLISHED" | "UNKNOWN" | "RECONCILING" | "SUSPENDED" | "RESUMING" | "RECLAIM_PENDING" | "RECLAIMED" | "RETAINED_NEEDS_ATTENTION" | "FAILED_NOT_APPLIED";
        /** @enum {string} */
        LaneDurabilityState: "LIVE_ONLY" | "CHECKPOINTING" | "CHECKPOINTED" | "DURABILITY_UNKNOWN";
        /** @enum {string} */
        GitOperationType: "CLONE" | "FETCH" | "MATERIALIZE" | "COMMIT" | "PUSH" | "PULL_REQUEST_CREATE";
        /** @enum {string} */
        GitOperationState: "CREATED" | "PREPARED" | "DISPATCHED" | "VERIFYING" | "SUCCEEDED" | "FAILED_NOT_APPLIED" | "CONFLICT" | "UNKNOWN" | "RECONCILING" | "CANCELLED";
        /** @enum {string} */
        GitDispatchState: "NOT_STARTED" | "STARTED" | "RETURNED";
        /** @enum {string} */
        GitEffectOutcome: "NOT_APPLIED" | "APPLIED" | "UNKNOWN";
        /** @enum {string} */
        RemotePublicationState: "DRAFT" | "APPROVED" | "PUSHING" | "PUSHED" | "PR_CREATING" | "PR_OPEN" | "MERGED" | "CLOSED" | "NOT_APPLIED" | "CONFLICT" | "UNKNOWN" | "RECONCILING";
        /** @enum {string} */
        PullRequestState: "OPEN" | "MERGED" | "CLOSED";
        /** @enum {string} */
        ChangeSetState: "ACTIVE" | "STALE" | "COMMITTED" | "ABANDONED";
        GitSafeError: {
            /** @description Stable error code catalog (design §10.8) */
            code: string;
            message: string;
            correlationId?: string | null;
        };
        GitOperationResponse: {
            operationId: string;
            operationType: components["schemas"]["GitOperationType"];
            state: components["schemas"]["GitOperationState"];
            dispatchState: components["schemas"]["GitDispatchState"];
            effectOutcome: components["schemas"]["GitEffectOutcome"];
            /** Format: int64 */
            resourceVersion: number;
            retrySafe: boolean;
            attentionRequired: boolean;
            safeError?: components["schemas"]["GitSafeError"];
        };
        RemoteWorkspaceLaneCreateRequest: {
            /** @default workspace-lane-create/2 */
            schemaVersion: string;
            sessionId: string;
            /** @description Authorized RepositoryBinding id; never a URL */
            repositoryId: string;
            /** @description Canonical refs/... name inside the project allowlist */
            baseRef: string;
            executionTarget?: string | null;
        };
        RemoteWorkspaceLaneCreateResponse: {
            operationId: string;
            lane: components["schemas"]["WorkspaceLaneResponse"];
        };
        WorkspaceLaneSyncRequest: {
            /** @default workspace-lane-sync/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedLaneVersion?: number | null;
            expectedHeadOid?: components["schemas"]["GitOid"];
        };
        WorkspaceLaneTreeResponse: {
            workspaceLaneId: string;
            entries: {
                path?: string;
                /** @enum {string} */
                kind?: "FILE" | "DIRECTORY";
                /** Format: int64 */
                sizeBytes?: number | null;
                fileRef?: string | null;
            }[];
            nextCursor?: string | null;
            truncated: boolean;
        };
        WorkspaceLaneFileResponse: {
            workspaceLaneId: string;
            fileRef: string;
            mediaType: string;
            /** @enum {string} */
            encoding: "UTF-8" | "BINARY";
            contentText?: string | null;
            /** Format: int64 */
            contentBytes: number;
            /** @description CAS version token "sha256:<digest>:<size>" */
            digest: string;
            revision: string;
            truncated: boolean;
        };
        GitLaneStatusResponse: {
            workspaceLaneId: string;
            baseRef?: string | null;
            baseOid?: components["schemas"]["GitOid"];
            workingRef?: string | null;
            headOid?: components["schemas"]["GitOid"];
            aheadCount?: number | null;
            behindCount?: number | null;
            dirtyFileCount?: number | null;
            stateToken?: string | null;
            laneState?: components["schemas"]["RemoteLaneState"];
        };
        ChangeSetCreateRequest: {
            /** @default change-set-create/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedLaneVersion?: number | null;
            expectedHeadOid?: components["schemas"]["GitOid"];
        };
        ChangeSetResponse: {
            changeSetId: string;
            workspaceLaneId: string;
            /** Format: int64 */
            laneRevision?: number | null;
            digest: string;
            state: components["schemas"]["ChangeSetState"];
            baseOid?: components["schemas"]["GitOid"];
            headOid?: components["schemas"]["GitOid"];
            changedFileCount?: number | null;
            additions?: number | null;
            deletions?: number | null;
            binaryFileCount?: number | null;
            evidenceRef?: string | null;
        };
        GitCommitCreateRequest: {
            /** @default git-commit-create/1 */
            schemaVersion: string;
            changeSetId: string;
            /** Format: int64 */
            expectedLaneVersion?: number | null;
            expectedHeadOid?: components["schemas"]["GitOid"];
            message?: string;
        };
        GitCommitResponse: {
            commitId: string;
            workspaceLaneId?: string | null;
            changeSetId?: string | null;
            parentOid?: components["schemas"]["GitOid"];
            treeOid?: components["schemas"]["GitOid"];
            commitOid: components["schemas"]["GitOid"];
            /** @enum {string|null} */
            authorPolicy?: "AGENT_ATTRIBUTED" | "HUMAN_ATTRIBUTED" | null;
            /** @enum {string|null} */
            provenance?: "EXTERNAL_MINIMAL" | "ENTERPRISE_LINKED" | null;
            operationId?: string | null;
            evidenceRef?: string | null;
        };
        RemotePublicationCreateRequest: {
            /** @default git-publication-create/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedCommitVersion?: number | null;
            /**
             * @description Bounded target; remote ref is service-assigned
             * @enum {string}
             */
            target?: "TASK_BRANCH";
            expectedRemoteOid?: components["schemas"]["GitOid"];
            createPullRequest?: boolean | null;
        };
        RemotePublicationResponse: {
            publicationId: string;
            commitId: string;
            repositoryId?: string | null;
            remoteRef: string;
            localCommitOid?: components["schemas"]["GitOid"];
            expectedRemoteOid?: components["schemas"]["GitOid"];
            observedRemoteOid?: components["schemas"]["GitOid"];
            state: components["schemas"]["RemotePublicationState"];
            effectOutcome?: components["schemas"]["GitEffectOutcome"];
            operationId?: string | null;
            pullRequestId?: string | null;
        };
        PullRequestCreateRequest: {
            /** @default pull-request-create/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedPublicationVersion?: number | null;
        };
        PullRequestResponse: {
            pullRequestId: string;
            publicationId: string;
            provider: string;
            externalId: string;
            /** @description HTTPS URL whose host matches the provider connection */
            webUrl: string;
            headOid?: components["schemas"]["GitOid"];
            baseOid?: components["schemas"]["GitOid"];
            state: components["schemas"]["PullRequestState"];
            operationId?: string | null;
            evidenceRef?: string | null;
        };
        GitOperationReconcileRequest: {
            /** @default git-operation-reconcile/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedOperationVersion?: number | null;
        };
        GitOperationCancelRequest: {
            /** @default git-operation-cancel/1 */
            schemaVersion: string;
            /** Format: int64 */
            expectedOperationVersion?: number | null;
            reason?: string | null;
        };
        /** @enum {string} */
        DeliveryState: "DRAFT" | "PREPARING" | "READY_FOR_REVIEW" | "APPROVED" | "QUEUED" | "APPLYING" | "APPLIED" | "VERIFYING" | "VERIFIED" | "FAILED" | "CONFLICT" | "UNKNOWN" | "RECONCILING" | "REBASING" | "REJECTED" | "NEEDS_ATTENTION";
        DeliveryCreateRequest: {
            projectId: string;
            workspaceLaneId: string;
            targetPolicy?: string;
            changeSetFingerprint?: string | null;
            baseRevision?: string | null;
            expectedTargetOid?: string | null;
            candidateRef?: string | null;
            verificationRecipeFingerprint?: string | null;
            dependencyClosureFingerprint?: string | null;
        };
        DeliveryPrepareRequest: {
            /** Format: int64 */
            expectedStateVersion: number;
            proposalFingerprint?: string | null;
            changeSetFingerprint?: string | null;
            baseRevision?: string | null;
            expectedTargetOid?: string | null;
            targetPolicy?: string | null;
            verificationRecipeFingerprint?: string | null;
            candidateRef?: string | null;
        };
        DeliveryDecisionRequest: {
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            /** Format: int64 */
            expectedStateVersion: number;
            approvalFingerprint: string;
            reason?: string | null;
        };
        DeliveryApplyRequest: {
            /** Format: int64 */
            expectedStateVersion: number;
            approvalFingerprint: string;
        };
        DeliveryReconcileRequest: {
            /** Format: int64 */
            expectedStateVersion: number;
            reconcileRef?: string | null;
            /** @enum {string|null} */
            outcome?: "APPLIED" | "VERIFIED" | "NOT_APPLIED" | "NEEDS_ATTENTION" | null;
            journalRef?: string | null;
            detail?: string | null;
        };
        DeliveryRebaseRequest: {
            /** Format: int64 */
            expectedStateVersion: number;
        };
        DeliveryResponse: {
            deliveryId: string;
            projectId: string;
            workspaceLaneId: string;
            changeSetFingerprint?: string | null;
            baseRevision?: string | null;
            expectedTargetOid?: string | null;
            targetPolicy?: string | null;
            verificationRecipeFingerprint?: string | null;
            approvalFingerprint?: string | null;
            state: components["schemas"]["DeliveryState"];
            /** Format: int64 */
            stateVersion: number;
            integrationAttemptId?: string | null;
            targetBeforeOid?: string | null;
            targetAfterOid?: string | null;
            journalRef?: string | null;
            evidenceManifestRef?: components["schemas"]["EvidenceManifestRef"];
            conflictSummary?: string | null;
            targetFingerprint?: string | null;
            preflightTargetFingerprint?: string | null;
            preflightConflictPaths?: string[];
            /** @description WU-06 (design §5.2): durable sync-session id this delivery's apply/reconcile/rebase ran under. */
            syncSessionId?: string | null;
            receiptId?: string | null;
            createdAt?: string | null;
            updatedAt?: string | null;
        };
        CommandReceiptResponse: {
            receiptId: string;
            commandType: string;
            aggregateId: string;
            requestHash: string;
            /** @enum {string} */
            outcome: "ACCEPTED" | "APPLIED" | "NOT_APPLIED" | "UNKNOWN";
            /** Format: int64 */
            aggregateVersion?: number | null;
            reconcileRef?: string | null;
        };
        DeliveryCommandResponse: {
            delivery: components["schemas"]["DeliveryResponse"];
            receipt: components["schemas"]["CommandReceiptResponse"];
        };
        DeliveryChangesResponse: {
            deliveryId: string;
            changeSetFingerprint: string;
            baseRevision?: string | null;
            targetLabel: string;
            targetFingerprint: string;
            canApply: boolean;
            conflictPaths: string[];
            files: components["schemas"]["DeliveryChangeFile"][];
        };
        DeliveryChangeFile: {
            path: string;
            /** @enum {string} */
            changeType: "CREATE" | "UPDATE" | "DELETE";
            beforeSha256?: string | null;
            afterSha256?: string | null;
            beforeText?: string | null;
            afterText?: string | null;
        };
        DeliveryListResponse: {
            items: components["schemas"]["DeliveryResponse"][];
            nextCursor?: string | null;
            truncated: boolean;
        };
        WorkspaceExecutionCreateRequest: {
            workspaceAlias: string;
            /** @enum {string} */
            kind: "CHECKOUT" | "WORKTREE" | "READ_ONLY_SNAPSHOT";
            /** @enum {string} */
            ownerType: "RUN" | "MISSION_WORK_ITEM" | "SESSION";
            ownerId: string;
            baselineRevision?: string | null;
            /** @enum {string|null} */
            startPolicy?: "CLEAN_HEAD" | "USER_WIP_SNAPSHOT" | "APPROVED_DELIVERY" | "FORK_SNAPSHOT" | null;
            wipSnapshotId?: string | null;
        };
        WorkspaceExecutionLeaseRenewRequest: {
            leaseId: string;
            /** Format: int64 */
            fencingToken: number;
        };
        WorkspaceExecutionHandoffRequest: {
            /** Format: int64 */
            expectedStateVersion: number | null;
        };
        WorkspaceExecutionReclaimRequest: {
            /** Format: int64 */
            expectedStateVersion: number | null;
        };
        WorkspaceExecutionResponse: {
            workspaceExecutionId: string;
            projectId: string;
            /** @enum {string} */
            kind: "CHECKOUT" | "WORKTREE" | "READ_ONLY_SNAPSHOT";
            baselineRevision?: string | null;
            /** @description Safe display alias; never a filesystem path. */
            workspaceRef: string;
            /** @enum {string} */
            ownerType: "RUN" | "MISSION_WORK_ITEM" | "SESSION";
            ownerId: string;
            leaseId?: string | null;
            /** Format: int64 */
            fencingToken?: number;
            /** @enum {string} */
            state: "PROVISIONING" | "READY" | "IN_USE" | "NEEDS_ATTENTION" | "READY_FOR_HANDOFF" | "RETAINED" | "RECLAIMED";
            dirtySummary?: string | null;
            leaseExpiresAt?: string | null;
            createdAt?: string | null;
            lastUsedAt?: string | null;
            /** Format: int64 */
            stateVersion: number;
            leaseExpired?: boolean;
        };
        WorkspaceExecutionListResponse: {
            projectId: string;
            items: components["schemas"]["WorkspaceExecutionResponse"][];
        };
        MissionBudget: {
            /** Format: int64 */
            maxModelTurns: number;
            /** Format: int64 */
            maxToolCalls: number;
            /** Format: int64 */
            maxWallClockMillis: number;
            /** Format: int64 */
            maxWorkItems: number;
        };
        MissionCreateRequest: {
            title: string;
            goal: string;
            workspaceAlias: string;
            sourceSpecId?: string | null;
            budget?: components["schemas"]["MissionBudget"];
        };
        MissionPlanRequest: {
            /** Format: int64 */
            expectedMissionVersion: number;
            plan: components["schemas"]["MissionPlan"];
        };
        MissionPlan: {
            schemaVersion: string;
            missionId: string;
            /** Format: int64 */
            revision?: number;
            goal: string;
            workspaceId?: string | null;
            baseSnapshotFingerprint?: string | null;
            approvedWriteScope?: string[];
            /** @description Milestone DAG nodes with nested work items and validation gates. */
            milestones: {
                [key: string]: unknown;
            }[];
            maximumParallelism?: number;
            riskPolicyFingerprint?: string | null;
            fingerprint: string;
            markdown?: string | null;
        };
        MissionCommandRequest: {
            /** Format: int64 */
            expectedMissionVersion: number;
            commandId?: string | null;
            expectedPlanFingerprint?: string | null;
            expectedBaselineFingerprint?: string | null;
            humanFeedback?: string | null;
        };
        MissionApprovalDecisionRequest: {
            approvalId?: string | null;
            /** Format: int64 */
            expectedMissionVersion: number;
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            planFingerprint?: string | null;
            policyFingerprint?: string | null;
            baseSnapshotFingerprint?: string | null;
            reason?: string | null;
            graphFingerprint?: string | null;
            deltaFingerprint?: string | null;
        };
        MissionResponse: {
            missionId: string;
            sessionId: string;
            title?: string | null;
            goal?: string | null;
            status: string;
            planFingerprint?: string | null;
            policyFingerprint?: string | null;
            baseSnapshotFingerprint?: string | null;
            activeMilestoneId?: string | null;
            /** Format: int64 */
            revision: number;
            /** Format: int64 */
            stateVersion: number;
            /** Format: int64 */
            createdAt?: number;
            /** Format: int64 */
            updatedAt?: number;
            budget: components["schemas"]["MissionBudget"];
            consumedBudget: components["schemas"]["MissionBudget"];
            plan?: components["schemas"]["MissionPlan"];
            workItemStatuses?: {
                [key: string]: string;
            };
            workItemFailures?: {
                [key: string]: string;
            };
            workerRunIds?: {
                [key: string]: string;
            };
            allowedActions?: string[];
            activePlanRunId?: string | null;
            pendingRevisionFingerprint?: string | null;
            pauseCheckpointRef?: string | null;
        };
        MissionArtifactsResponse: {
            [key: string]: unknown;
        };
        PolicyLayerResponse: {
            /** @enum {string} */
            layer: "MANAGED" | "PROJECT" | "USER";
            /** @enum {string|null} */
            maximumAutonomy?: "OFF" | "LOW" | "MEDIUM" | "HIGH" | null;
            /** Format: int64 */
            revision: number;
            policyId?: string | null;
            /** Format: int64 */
            policyRevision?: number;
        };
        PolicyLayersResponse: {
            layers: components["schemas"]["PolicyLayerResponse"][];
            effectiveMaximumAutonomy: string;
            /** Format: int64 */
            effectiveRevision: number;
        };
        PolicyLayerUpdateRequest: {
            /** @enum {string} */
            maximumAutonomy: "OFF" | "LOW" | "MEDIUM" | "HIGH";
            /** Format: int64 */
            expectedRevision?: number | null;
        };
        ProductSettingsResponse: {
            /** Format: int64 */
            revision: number;
            traceExportEnabled: boolean;
            localOnly: boolean;
            eventJournalRetentionDays: number;
            telemetryMinimal: boolean;
        };
        ProductSettingsUpdateRequest: {
            traceExportEnabled?: boolean | null;
            localOnly?: boolean | null;
            eventJournalRetentionDays?: number | null;
            /** Format: int64 */
            expectedRevision?: number | null;
        };
        KnowledgeItemResponse: {
            knowledgeId: string;
            /** @enum {string} */
            status: "PENDING" | "CONFIRMED" | "REJECTED";
            content: string;
            sourceRef?: string | null;
            createdAt?: string | null;
            confirmedAt?: string | null;
        };
        KnowledgeListResponse: {
            items: components["schemas"]["KnowledgeItemResponse"][];
            /** @description Only CONFIRMED items; pending suggestions are never facts. */
            facts: components["schemas"]["KnowledgeItemResponse"][];
        };
        SpecCreateRequest: {
            title?: string | null;
            goal: string;
            workspaceAlias: string;
            sourceMessageId?: string | null;
        };
        SpecRevisionRequest: {
            /** Format: int64 */
            expectedRevision: number;
            title?: string | null;
            goal?: string | null;
            sourceMessageId?: string | null;
        };
        SpecApprovalDecisionRequest: {
            approvalId: string;
            /** Format: int64 */
            expectedRevision: number;
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            contractFingerprint?: string | null;
            policyFingerprint?: string | null;
            workspaceBaselineFingerprint?: string | null;
            planFingerprint?: string | null;
            reason?: string | null;
        };
        SpecApprovalResponse: {
            approvalId?: string;
            specId?: string;
            /** Format: int64 */
            revision?: number;
            decision?: string | null;
            contractFingerprint?: string | null;
            policyFingerprint?: string | null;
            workspaceBaselineFingerprint?: string | null;
            planFingerprint?: string | null;
            decidedAt?: string | null;
            reason?: string | null;
        };
        SpecConversionResponse: {
            specId?: string;
            /** Format: int64 */
            revision?: number;
            taskId?: string | null;
            taskFingerprint?: string | null;
            status?: string | null;
        };
        SpecResponse: {
            specId?: string;
            sessionId?: string | null;
            /** Format: int64 */
            revision?: number;
            status?: string | null;
            sourceMessageId?: string | null;
            workspaceId?: string | null;
            workspaceBaselineFingerprint?: string | null;
            contractMarkdown?: string | null;
            contractFingerprint?: string | null;
            policyFingerprint?: string | null;
            proposalId?: string | null;
            planFingerprint?: string | null;
            approvalId?: string | null;
            createdAt?: string | null;
            updatedAt?: string | null;
            approvedAt?: string | null;
        };
        PendingCommandApproval: {
            runId?: string;
            approvalId: string;
            fingerprint: string;
            executable: string;
            arguments: string[];
            workingDirectory: string;
            /** Format: int64 */
            timeoutMillis: number;
            /** Format: int64 */
            createdAtMillis?: number;
            environmentVariableNames: string[];
            stdinPresent: boolean;
            /** Format: int64 */
            expiresAtMillis: number;
        };
        CommandApprovalDecision: {
            fingerprint: string;
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
        };
        BudgetApprovalDecision: {
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            requestFingerprint: string;
            approverId?: string | null;
            comment?: string | null;
        };
        BudgetApprovalServiceDecisionRequest: {
            /** @enum {string} */
            decision: "APPROVE" | "DENY";
            requestFingerprint: string;
            idempotencyKey: string;
            approverId?: string | null;
            comment?: string | null;
            approvedTopUp: components["schemas"]["BudgetApprovalTopUp"];
        };
        BudgetApprovalResponse: {
            runId: string;
            approvalId: string;
            /** @enum {string} */
            status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
            checkpointRef?: string | null;
            requestFingerprint: string;
            /** Format: int64 */
            createdAt?: number;
            /** Format: int64 */
            expiresAt?: number;
            request?: components["schemas"]["BudgetApprovalRequest"];
            decision?: string | null;
            approverId?: string | null;
            comment?: string | null;
            /** Format: int64 */
            decidedAt?: number | null;
            approvedTopUp?: components["schemas"]["BudgetApprovalTopUp"];
        };
        BudgetApprovalRequest: {
            approvalId?: string;
            productRunId?: string | null;
            businessRunId?: string | null;
            reasonCode?: string | null;
            checkpointRef?: string | null;
            checkpointRevision?: number;
            requestFingerprint?: string;
            usedBudget?: components["schemas"]["BudgetApprovalSnapshot"];
            remainingBudget?: components["schemas"]["BudgetApprovalSnapshot"];
            requestedTopUp?: components["schemas"]["BudgetApprovalTopUp"];
            maximumAllowedTopUp?: components["schemas"]["BudgetApprovalTopUp"];
            /** Format: int64 */
            estimatedCostMicros?: number;
            costKnown?: boolean;
            currency?: string | null;
            pricingRevision?: string | null;
            modelProfile?: string | null;
            provider?: string | null;
            /** Format: int64 */
            createdAtMillis?: number;
            /** Format: int64 */
            expiresAtMillis?: number;
        };
        BudgetApprovalSnapshot: {
            stepCount?: number;
            maxSteps?: number;
            logicalModelCalls?: number;
            maxModelHttpRequests?: number;
            recoveryRequests?: number;
            maxRecoveryRequests?: number;
            /** Format: int64 */
            runElapsedMillis?: number;
            /** Format: int64 */
            runDeadlineMillis?: number;
            /** Format: int64 */
            inputTokens?: number;
            /** Format: int64 */
            outputTokens?: number;
            /** Format: int64 */
            estimatedCostMicros?: number;
            costKnown?: boolean;
            currency?: string | null;
            pricingRevision?: string | null;
        };
        BudgetApprovalTopUp: {
            maxSteps: number;
            maxModelHttpRequests: number;
            maxRecoveryRequests: number;
            /** Format: int64 */
            additionalRunMillis: number;
            /** Format: int64 */
            maxCostMicros: number;
        };
        SessionCreateRequest: {
            /** @enum {string|null} */
            executionOwnership?: "HOST_SESSION" | "WORKER_ATTEMPT" | null;
            executionBinding?: components["schemas"]["WorkerSessionBinding"];
            schemaVersion?: string;
            title?: string | null;
            /** @description Omit for an ordinary workspace-free read-only chat; required for implementation sessions. */
            workspaceAlias?: string | null;
            interactionMode?: string | null;
            /**
             * @description User intent is orthogonal to execution mode; REVIEW is read-only.
             * @enum {string|null}
             */
            intent?: "ASK" | "REVIEW" | "EXPLAIN" | "DESIGN" | "IMPLEMENT" | null;
            executionMode?: string | null;
            autonomyLevel?: string | null;
            /**
             * @description Independent contract override. FULL_ACCESS is not a third interaction mode.
             * @enum {string|null}
             */
            permissionMode?: "WORKSPACE" | "FULL_ACCESS" | null;
            policyFingerprint?: string | null;
            preflightRevision?: string | null;
            workspaceFingerprint?: string | null;
            /** @description Contract directories with edit permission when a workspace is selected; applied on the next turn. */
            writeAllow?: string[];
            /** @description Contract directories retained as read-only context; applied on the next turn. */
            writeForbid?: string[];
            /** @description User-provided path hints for model context; never a write permission scope. */
            contextDirectories?: string[];
            /** @description Explicit v2 directory rows. Presence selects directory policy version 2; null is invalid. */
            directories?: components["schemas"]["SessionDirectory"][] | null;
            /**
             * @description Required with directories on create; v2 is monotonic.
             * @enum {integer|null}
             */
            directoryPolicyVersion?: 2 | null;
            verificationLevel?: string | null;
            maxModelTurns?: number;
            maxEditAttempts?: number;
            workspacePolicy?: components["schemas"]["WorkspacePolicy"];
            /** @description User-selected specialist profile; only valid for workspace-bound sessions. */
            agentProfileId?: string | null;
            /** @description Optional optimistic revision check for the selected profile. */
            agentProfileRevision?: string | null;
            /**
             * @description Session-level preference for automatic read-only research delegation.
             * @enum {string|null}
             */
            readonlyResearchMode?: "AUTO" | "OFF" | null;
            /** @description Whether a workspace-backed session should list the workspace before its first model turn; later turns never repeat this deterministic step. */
            initialWorkspaceListing?: boolean | null;
        };
        SessionPatchRequest: {
            /** Format: int64 */
            expectedSessionVersion: number;
            title?: string | null;
            /** @description Empty string removes workspace membership; a valid alias moves the session. Applied on the next turn. */
            workspaceAlias?: string | null;
            interactionMode?: string | null;
            /** @enum {string|null} */
            intent?: "ASK" | "REVIEW" | "EXPLAIN" | "DESIGN" | "IMPLEMENT" | null;
            /**
             * @description Independent contract override. FULL_ACCESS is not a third interaction mode.
             * @enum {string|null}
             */
            permissionMode?: "WORKSPACE" | "FULL_ACCESS" | null;
            executionMode?: string | null;
            autonomyLevel?: string | null;
            policyFingerprint?: string | null;
            /** @description Contract directories with edit permission. Applied on the next turn. */
            writeAllow?: string[];
            /** @description Contract directories retained as read-only context. Applied on the next turn. */
            writeForbid?: string[];
            /** @description User-provided path hints for model context; never a write permission scope. */
            contextDirectories?: string[];
            /** @description Explicit v2 directory rows. Omitted means unchanged; an empty array clears all rows. */
            directories?: components["schemas"]["SessionDirectory"][] | null;
            /**
             * @description Required when upgrading a v1 session; optional for an existing v2 session.
             * @enum {integer|null}
             */
            directoryPolicyVersion?: 2 | null;
            /** @description Required true when the first v2 list replaces legacy write rules. */
            replaceLegacyDirectoryPolicy?: boolean | null;
            verificationLevel?: string | null;
            /**
             * @description Session-level extension default (extension design §4.1). A new
             *     default only affects the next user message; in-flight
             *     executions keep their frozen binding.
             */
            extensions?: components["schemas"]["ExtensionSelection"];
            maxModelTurns?: number | null;
            maxEditAttempts?: number | null;
            /** @description EW9 session model policy; must reference a configured catalog entry. */
            modelAlias?: string | null;
            modelSettings?: components["schemas"]["SessionModelSettings"];
        };
        SessionModelSettings: {
            providerId?: string | null;
            modelAlias?: string | null;
            catalogRevision?: string | null;
            /** @enum {string} */
            reasoningMode?: "DEFAULT" | "OFF" | "EFFORT" | "MANUAL_BUDGET";
            reasoningOptionId?: string | null;
            /**
             * @deprecated
             * @description Legacy compatibility field; clients must select a reasoning option instead.
             */
            reasoningBudgetTokens?: number | null;
            /** @enum {string} */
            contextMode?: "AUTO" | "PRESET" | "CUSTOM";
            /** @description Selected id from the target model's contextTokenOptions; clients do not enter raw token values. */
            contextPresetId?: string | null;
            /**
             * @deprecated
             * @description Server-resolved value of contextPresetId; clients must select a preset instead.
             */
            contextMaxTokens?: number | null;
            /** @enum {string} */
            outputMode?: "AUTO" | "CUSTOM";
            /**
             * @deprecated
             * @description Runtime-owned output allocation; not a session user setting.
             */
            outputMaxTokens?: number | null;
        };
        SessionModelSettingsPatchRequest: {
            /** Format: int64 */
            expectedSettingsRevision: number;
            /** @enum {string} */
            applyPolicy?: "NEXT_SAFE_REQUEST";
            settings: components["schemas"]["SessionModelSettings"];
        };
        SessionModelSettingsResponse: {
            sessionId: string;
            /** Format: int64 */
            settingsRevision: number;
            /** Format: int64 */
            sessionVersion?: number;
            changeId?: string | null;
            /** @enum {string} */
            transitionState: "READY" | "PENDING" | "PREPARING" | "APPLIED" | "FAILED";
            activeRunId?: string | null;
            effectiveEpochId?: string | null;
            lastRequestId?: string | null;
            error?: string | null;
            desired: components["schemas"]["SessionModelSettings"];
            effective?: components["schemas"]["SessionModelSettings"];
        };
        SessionMessageRequest: {
            clientMessageId: string;
            content: string;
            /**
             * Format: int64
             * @description Session version observed immediately before this message intent.
             */
            expectedSessionVersion: number;
            /**
             * @description Per-message extension selection (extension design §4.1).
             *     Omitted inherits the session setting; an explicit object freezes
             *     this turn's MCP servers/skills.
             */
            extensions?: components["schemas"]["ExtensionSelection"];
            /**
             * @description Multimodal attachments (EW10.1 + 2026-09-08 multimodal design
             *     7.4/WU-10). Wire whitelist: image/png|jpeg|webp|gif,
             *     application/pdf, text/plain|markdown. Execution accepts
             *     text/plain|markdown (TEXT, 256 KiB decoded each) and
             *     image/png|jpeg (IMAGE, static single frame, 4 MiB decoded each,
             *     8192 px per side, 16M pixels); the whole message is bounded to
             *     4 attachments and 8 MiB decoded in total. Request bodies are
             *     capped at ceil(totalAttachmentBytes/3)*4 + 1 MiB + 64 KiB.
             *     Exactly one of dataBase64 or sourceAttachmentRef must be
             *     provided per attachment. Bytes never enter events.
             */
            attachments?: {
                clientAttachmentId?: string | null;
                name: string;
                /** @enum {string} */
                mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf" | "text/plain" | "text/markdown";
                /** @description Base64 payload; mutually exclusive with sourceAttachmentRef. */
                dataBase64?: string;
                /**
                 * @description Image detail hint (multimodal design 7.4). IMAGE
                 *     attachments only; default AUTO. Provider-level negotiation
                 *     happens during request preparation.
                 * @enum {string|null}
                 */
                detail?: "AUTO" | "LOW" | "HIGH" | "ORIGINAL" | null;
                /**
                 * @description Re-reference an already accepted IMAGE attachment of the
                 *     SAME session (multimodal design 7.4). The server resolves
                 *     authoritative name/MIME/hash/size metadata; the reference
                 *     still counts toward this message's attachment count and
                 *     byte budget.
                 */
                sourceAttachmentRef?: {
                    messageId: string;
                    attachmentId: string;
                } | null;
            }[];
        };
        SessionMessageResponse: {
            messageId?: string | null;
            clientMessageId?: string | null;
            taskId?: string | null;
            runId?: string | null;
            status?: string | null;
            /** Format: int64 */
            sessionVersion?: number;
            /** Format: int64 */
            eventCursor?: number;
            receiptId?: string | null;
            /** @description Redacted attachment metadata; bytes never appear here. */
            attachments?: {
                clientAttachmentId?: string | null;
                /** @description Stable service-derived attachment identity (unique within the message). */
                attachmentId?: string | null;
                name?: string | null;
                /**
                 * @description TEXT/IMAGE since inputVersion=2; legacy text rows report DOCUMENT.
                 * @enum {string|null}
                 */
                kind?: "TEXT" | "IMAGE" | "DOCUMENT" | null;
                mediaType?: string | null;
                /** Format: int64 */
                sizeBytes?: number;
                /** @description IMAGE only; decoded pixel width. */
                width?: number | null;
                /** @description IMAGE only; decoded pixel height. */
                height?: number | null;
                /** @description IMAGE only; AUTO/LOW/HIGH/ORIGINAL hint. */
                detail?: string | null;
                /** @enum {string} */
                status?: "ACCEPTED" | "REJECTED";
                reasonCode?: string | null;
            }[];
        };
        SourceFetchRequest: {
            /**
             * @description EW10.2 source classification recorded in provenance. All three are
             *     http(s) documents fetched by the same read-only adapter in this
             *     increment; dedicated per-type adapters stay behind future flags.
             * @enum {string}
             */
            sourceType: "WEB" | "ISSUE" | "DOCS";
            /**
             * @description Absolute http/https URI. Explicit ports, user info and non-public
             *     hosts are rejected by the service; every redirect hop is
             *     re-validated.
             */
            uri: string;
            /** @description Optional smaller read cap; the 256 KiB service hard cap always wins. */
            maxBytes?: number | null;
        };
        /**
         * @description Provenance-carrying read-only source result (design 10.9). Content is
         *     untrusted data, never system authority; bytes never enter the durable
         *     journal and URIs are never logged.
         */
        SourceFetchResponse: {
            sourceType?: string | null;
            sourceUri?: string | null;
            /** @description Last URI after redirects; equals sourceUri when no redirect happened. */
            finalUri?: string | null;
            fetchedAt?: string | null;
            /** @description Media type with parameters stripped; text-like types only. */
            contentType?: string | null;
            /** Format: int64 */
            contentBytes?: number | null;
            /** @description Decoded text; null when the content type is not text-like. */
            contentText?: string | null;
            truncated?: boolean | null;
            /** @description Always true; UIs must render the payload as plain text with an untrusted marker. */
            untrustedContent?: boolean | null;
            redirectCount?: number | null;
            statusCode?: number | null;
        };
        /**
         * @description Public-safe MCP server summary (EW10.3). Command, argument and
         *     environment configuration never leaves the service process.
         */
        McpServerSummary: {
            serverId?: string | null;
            /** @enum {string|null} */
            status?: "READY" | "UNAVAILABLE" | "DISABLED" | null;
            /** @description Safe reason code only; never raw stderr or host details. */
            reason?: string | null;
            resourceCount?: number | null;
        };
        McpResourceDescriptor: {
            uri?: string | null;
            name?: string | null;
            mimeType?: string | null;
            description?: string | null;
        };
        McpResourceReadRequest: {
            /** @description Resource URI as listed by the server; control characters are rejected. */
            uri: string;
            /**
             * @description WU11 MRTR retry: responses keyed exactly to the inputRequests map
             *     of a prior 409 MCP_MRTR_INPUT_REQUIRED answer. The retry carries
             *     the same uri + these responses + the verbatim requestState.
             */
            inputResponses?: Record<string, never> | null;
            /** @description Opaque requestState echoed verbatim from the prior input_required result. */
            requestState?: string | null;
        };
        /**
         * @description Provenance-carrying read-only MCP resource result (EW10.3). Content
         *     is untrusted data, never system authority; bytes never enter the
         *     durable journal and server errors never leak raw stderr.
         */
        McpResourceReadResponse: {
            serverId?: string | null;
            uri?: string | null;
            mimeType?: string | null;
            /** Format: int64 */
            contentBytes?: number | null;
            /** @description Decoded text; null when the server returned a binary blob. */
            contentText?: string | null;
            truncated?: boolean | null;
            /** @description Always true; UIs must render the payload as plain text with an untrusted marker. */
            untrustedContent?: boolean | null;
            fetchedAt?: string | null;
            /**
             * @description Normalized content blocks with provenance, per-item digests
             *     and EXTERNAL_UNTRUSTED classification (WU07); present when
             *     the governed extension path answered the read.
             */
            blocks?: components["schemas"]["ExtensionContentBlock"][] | null;
        };
        SkillRegisterRequest: {
            name: string;
            version: string;
            /** @description Provenance tag of the author/installer, e.g. builtin or user. */
            source: string;
            /** @enum {string} */
            scope: "PROJECT" | "USER";
            /** @description Required when scope is PROJECT; the registered workspace alias. */
            projectAlias?: string | null;
            /** @description Visible instruction body; bounded by the service hard limit. */
            instructions: string;
            /** @description Declared capability tags for the permission preview; advisory in EW10.5. */
            permissions?: string[];
        };
        /**
         * @description Catalog entry; instructions are visible by design and the catalog
         *     never executes anything.
         */
        SkillRecordResponse: {
            skillId?: string | null;
            name?: string | null;
            version?: string | null;
            source?: string | null;
            /** @enum {string|null} */
            scope?: "PROJECT" | "USER" | null;
            projectAlias?: string | null;
            instructions?: string | null;
            permissions?: string[];
            /** @enum {string|null} */
            status?: "ACTIVE" | "DISABLED" | "REVOKED" | null;
            /** Format: int64 */
            revision?: number | null;
            createdAt?: string | null;
            updatedAt?: string | null;
        };
        SkillStatusRequest: {
            /** @enum {string} */
            status: "ACTIVE" | "DISABLED" | "REVOKED";
            /** Format: int64 */
            expectedRevision: number;
        };
        /**
         * @description Per-message or per-session extension selection (extension design
         *     §4.1). Selection is not an approval: the effective set is the
         *     intersection with host policy, session mode, grants and the
         *     current enable state.
         */
        ExtensionSelection: {
            /**
             * @description INHERIT follows the session setting; NONE disables extensions
             *     for this scope; EXPLICIT uses exactly the listed references —
             *     empty arrays mean nothing selected, never "all".
             * @enum {string}
             */
            mode?: "INHERIT" | "NONE" | "EXPLICIT";
            mcpServers?: components["schemas"]["McpServerSelection"][];
            skills?: components["schemas"]["SkillSelection"][];
            /** @description M2 automatic candidate activation; default false. */
            autoSkills?: boolean;
        };
        McpServerSelection: {
            serverId: string;
            /** @description Internal stable tool ids admitted this run; empty means none. */
            toolIds?: string[];
            /** @default false */
            resourcesEnabled: boolean;
        };
        SkillSelection: {
            skillId: string;
            /** @description Immutable package digest (e.g. sha256:...); the frozen version for this run. */
            versionDigest: string;
        };
        /**
         * @description Server configuration. The body never carries credential material;
         *     envKeys/headerKeys are slot NAMES resolved against the host
         *     credential store at launch, not values.
         */
        McpServerConfigRequest: {
            displayName: string;
            /** @enum {string} */
            scope: "USER" | "PROJECT";
            /** @description Required when scope is PROJECT. */
            projectId?: string | null;
            /** @default true */
            enabled: boolean;
            /**
             * @description PIN uses only protocolProfile; AUTO (M3) probes across eras.
             * @default PIN
             * @enum {string}
             */
            protocolPolicy: "AUTO" | "PIN";
            /** @enum {string|null} */
            protocolProfile?: "LEGACY_2024_11_05" | "LEGACY_2025_11_25" | "MODERN_2026_07_28" | null;
            transport: components["schemas"]["McpTransportConfig"];
            /** @description Credential slot name in the host store; never the value. */
            credentialRef?: string | null;
            /**
             * @description WU09: pre-registered OAuth public client id for
             *     STREAMABLE_HTTP authMode=OAUTH — config data, never a
             *     credential slot or network header.
             */
            oauthClientId?: string | null;
            /** @description Server-managed risk policy reference. */
            policyRef?: string | null;
            /**
             * @description WU01 (design 2026-09-29 section 4.1): AUTO only negotiates inside
             *     this tested allowlist of protocol versions.
             */
            allowedVersions?: string[] | null;
            runtime?: components["schemas"]["McpRuntimeConfig"] | null;
            /** @description Built-in test template the config derives from; no implied grant. */
            templateRef?: string | null;
            templateVersion?: string | null;
        };
        /**
         * @description WU01 (design 2026-09-29 section 4.1): runtime execution semantics.
         *     The backend decides the isolation strength a server may claim;
         *     LOCAL_PROCESS is a managed process, not an OS filesystem sandbox.
         */
        McpRuntimeConfig: {
            /**
             * @description STATELESS_SHARED requires a host-approved basis.
             * @default EXECUTION
             * @enum {string}
             */
            isolationScope: "EXECUTION" | "SESSION" | "STATELESS_SHARED";
            /**
             * @default LOCAL_PROCESS
             * @enum {string}
             */
            backend: "LOCAL_PROCESS" | "OCI";
            /** @description Resolved absolute toolchain executable binding reference. */
            toolchainBindingRef?: string | null;
            /** @description Locked package version/digest reference. */
            packageLockRef?: string | null;
        };
        /**
         * @description WU01 (design 2026-09-29 section 4.1): STREAMABLE_HTTP endpoint
         *     authentication. References only — credential material never travels
         *     this API.
         */
        McpHttpAuthConfig: {
            /**
             * @default NONE
             * @enum {string}
             */
            kind: "NONE" | "BEARER" | "API_KEY" | "OAUTH";
            /** @description Credential slot reference for BEARER/API_KEY; never the value. */
            credentialRef?: string | null;
            /** @description OAuth client configuration reference for OAUTH. */
            oauthConfigRef?: string | null;
        };
        McpTransportConfig: {
            /** @enum {string} */
            kind: "STDIO" | "STREAMABLE_HTTP";
            /** @description STDIO executable; passed to ProcessBuilder argv[0], never through a shell. */
            executable?: string | null;
            /** @description STDIO argv elements verbatim; no shell splitting or re-expansion. */
            args?: string[];
            /** @description Verified working directory for STDIO launches. */
            cwd?: string | null;
            /**
             * @description Names of host credential-store slots whose values are injected
             *     into the child environment at launch. Values never travel this API.
             */
            envKeys?: string[];
            /**
             * @description WU01 (design 2026-09-29 section 4.1): envName to secretRef mapping.
             *     Credential values are injected from the host store; the slot name
             *     no longer has to equal the env name.
             */
            secretEnv?: {
                [key: string]: string;
            } | null;
            auth?: components["schemas"]["McpHttpAuthConfig"] | null;
            /** @description STREAMABLE_HTTP endpoint; HTTPS required outside explicit loopback dev profiles. */
            endpoint?: string | null;
            /**
             * @description Explicit dev escape (WU10): permits a plain-HTTP endpoint only
             *     when the host is a loopback literal (127.x, ::1 or localhost).
             *     Also admits loopback DNS answers through the egress guard. The
             *     endpoint itself still requires this flag to take effect.
             */
            allowInsecureLoopback?: boolean | null;
            /** @description Host credential-store slot names bound to outbound headers. */
            headerKeys?: string[];
            /** Format: int64 */
            connectTimeoutMillis?: number | null;
            /** Format: int64 */
            callTimeoutMillis?: number | null;
        };
        McpServerUpdateRequest: {
            displayName?: string | null;
            enabled?: boolean | null;
            /** @enum {string|null} */
            protocolPolicy?: "AUTO" | "PIN" | null;
            /** @enum {string|null} */
            protocolProfile?: "LEGACY_2024_11_05" | "LEGACY_2025_11_25" | "MODERN_2026_07_28" | null;
            transport?: components["schemas"]["McpTransportConfig"];
            credentialRef?: string | null;
            /** @description Pre-registered OAuth public client id (WU09). */
            oauthClientId?: string | null;
            policyRef?: string | null;
            /**
             * Format: int64
             * @description Optimistic concurrency token; EXT_REVISION_CONFLICT on mismatch.
             */
            expectedRevision: number;
        };
        McpServerStatusRequest: {
            enabled: boolean;
            /** Format: int64 */
            expectedRevision: number;
        };
        /**
         * @description Public-safe server detail (extension design §5.1). Configuration is
         *     redacted: executable/args are summarized by digest and counts,
         *     credentialRef is reported as a slot presence flag only.
         */
        McpServerDetailResponse: {
            serverId?: string | null;
            displayName?: string | null;
            /** @enum {string|null} */
            scope?: "USER" | "PROJECT" | "OPERATOR" | null;
            projectId?: string | null;
            /** @enum {string|null} */
            transportKind?: "STDIO" | "STREAMABLE_HTTP" | null;
            enabled?: boolean | null;
            /** Format: int64 */
            revision?: number | null;
            configDigest?: string | null;
            /** @enum {string|null} */
            connectionState?: "DISABLED" | "STOPPED" | "CONNECTING" | "READY" | "AUTH_REQUIRED" | "DEGRADED" | "FAILED" | "UNSUPPORTED" | null;
            /** @description Stable reason code only; never stderr or host detail. */
            stateReason?: string | null;
            protocolProfile?: string | null;
            toolCount?: number | null;
            resourceCount?: number | null;
            promptCount?: number | null;
            hasCredential?: boolean | null;
            /**
             * @description Endpoint anchoring (WU01). Rows predating the field are DIRECT;
             *     HUB rows are materialized by the hub-association surface and
             *     carry hubConnectionId. Source marking only — not launch config.
             * @enum {string|null}
             */
            connectionMode?: "DIRECT" | "HUB" | null;
            hubConnectionId?: string | null;
            lastReadyAt?: string | null;
            createdAt?: string | null;
            updatedAt?: string | null;
        };
        McpConnectionActionRequest: {
            /** @enum {string} */
            action: "CONNECT" | "TEST" | "DISCONNECT" | "RESTART" | "DIAGNOSE";
        };
        McpOperationResponse: {
            operationId?: string | null;
            serverId?: string | null;
            /** @enum {string|null} */
            kind?: "CONNECT" | "TEST" | "DISCONNECT" | "RESTART" | "DIAGNOSE" | "CATALOG_REFRESH" | "AUTH" | null;
            /** @enum {string|null} */
            status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | null;
            detail?: string | null;
            createdAt?: string | null;
            finishedAt?: string | null;
        };
        /**
         * @description One catalogued MCP tool. Annotations are UI hints only — they never
         *     grant read/write or idempotent rights (extension design §5.4).
         */
        McpToolDescriptorView: {
            /** @description Stable internal registration id. */
            toolId?: string | null;
            /** @description Server-reported name, case preserved. */
            rawName?: string | null;
            title?: string | null;
            description?: string | null;
            inputSchema?: {
                [key: string]: unknown;
            } | null;
            outputSchema?: {
                [key: string]: unknown;
            } | null;
            annotations?: {
                [key: string]: unknown;
            } | null;
            schemaDigest?: string | null;
            /** @enum {string|null} */
            effectiveRisk?: "READ_ONLY" | "WRITE" | "EXTERNAL_EFFECT" | "HIGH_RISK" | null;
            /** @enum {string|null} */
            availability?: "AVAILABLE" | "DISABLED" | "UNAVAILABLE" | "DEGRADED" | "INVALID_SCHEMA" | "UNSUPPORTED_SCHEMA" | null;
            /** @description Stable reason when availability is not AVAILABLE (schema rejection code + detail). */
            availabilityReason?: string | null;
            /** @description JSON Schema dialect the input schema was accepted under (e.g. 2020-12). */
            schemaDialect?: string | null;
            /** @description Validator id + version that accepted the schema. */
            validatorVersion?: string | null;
        };
        McpToolListResponse: {
            items?: components["schemas"]["McpToolDescriptorView"][];
            nextCursor?: string | null;
            /** Format: int64 */
            catalogRevision?: number | null;
            cached?: boolean | null;
        };
        McpResourceTemplateView: {
            uriTemplate?: string | null;
            name?: string | null;
            description?: string | null;
            mimeType?: string | null;
        };
        McpResourceTemplateListResponse: {
            items?: components["schemas"]["McpResourceTemplateView"][];
            nextCursor?: string | null;
        };
        McpPromptDescriptorView: {
            name?: string | null;
            title?: string | null;
            description?: string | null;
            arguments?: {
                name?: string | null;
                description?: string | null;
                required?: boolean | null;
            }[] | null;
        };
        McpPromptListResponse: {
            items?: components["schemas"]["McpPromptDescriptorView"][];
            nextCursor?: string | null;
        };
        McpPromptResolveRequest: {
            name: string;
            arguments?: {
                [key: string]: string;
            } | null;
            /**
             * @description WU11 MRTR retry: responses keyed exactly to the inputRequests map
             *     of a prior 409 MCP_MRTR_INPUT_REQUIRED answer.
             */
            inputResponses?: Record<string, never> | null;
            /** @description Opaque requestState echoed verbatim from the prior input_required result. */
            requestState?: string | null;
        };
        McpPromptResolveResponse: {
            promptName?: string | null;
            blocks?: components["schemas"]["ExtensionContentBlock"][];
            provenance?: string | null;
        };
        McpAuthActionRequest: {
            /** @enum {string} */
            action: "START" | "CANCEL" | "REVOKE";
        };
        McpAuthActionResponse: {
            operationId?: string | null;
            /** @enum {string|null} */
            status?: "PENDING" | "AUTH_REQUIRED" | "CANCELLED" | "REVOKED" | "COMPLETED" | "FAILED" | null;
            /** @description Host-generated user-consent URL opened by the desktop shell; expires quickly. */
            loginUrl?: string | null;
        };
        /**
         * @description Normalized external content block (extension design §5.6). Text
         *     payloads are bounded; large or binary payloads are carried by
         *     artifactRef only.
         */
        ExtensionContentBlock: {
            /** @enum {string|null} */
            kind?: "TEXT" | "STRUCTURED" | "IMAGE_REF" | "AUDIO_REF" | "RESOURCE_LINK" | "EMBEDDED_RESOURCE" | null;
            mimeType?: string | null;
            text?: string | null;
            artifactRef?: string | null;
            sourceRef?: string | null;
            /** @description Digest of the bytes actually persisted (artifact or block text). */
            sha256?: string | null;
            /** @description Digest of the untruncated source payload; set only when truncated. */
            sourceSha256?: string | null;
            /** Format: int64 */
            originalBytes?: number | null;
            /** Format: int64 */
            includedBytes?: number | null;
            truncated?: boolean | null;
            /** @enum {string|null} */
            dataClassification?: "PUBLIC_SAFE" | "EXTERNAL_UNTRUSTED" | "SENSITIVE" | null;
        };
        /**
         * @description Lightweight catalog row (view=SUMMARY): no instruction body, used
         *     for large catalogs. Selection still needs the digest-pinned detail.
         */
        SkillSummaryResponse: {
            skillId?: string | null;
            name?: string | null;
            description?: string | null;
            /** @enum {string|null} */
            scope?: "PROJECT" | "USER" | "BUILTIN" | null;
            projectAlias?: string | null;
            /** @enum {string|null} */
            status?: "ACTIVE" | "DISABLED" | "REVOKED" | "NEEDS_METADATA" | null;
            currentVersionDigest?: string | null;
            versionCount?: number | null;
            /** Format: int64 */
            revision?: number | null;
            permissionHints?: string[] | null;
            updatedAt?: string | null;
        };
        SkillVersionView: {
            versionId?: string | null;
            packageDigest?: string | null;
            /** @enum {string|null} */
            format?: "STANDARD_PACKAGE" | "LEGACY_INLINE" | null;
            /** @description metadata.version or short digest. */
            displayVersion?: string | null;
            importedAt?: string | null;
            fileCount?: number | null;
            /** Format: int64 */
            entryBytes?: number | null;
            sourceSummary?: string | null;
        };
        SkillDiagnostic: {
            code?: string | null;
            /** @enum {string|null} */
            severity?: "INFO" | "WARN" | "ERROR" | null;
            message?: string | null;
            path?: string | null;
        };
        SkillDetailResponse: {
            skillId?: string | null;
            name?: string | null;
            description?: string | null;
            /** @enum {string|null} */
            scope?: "PROJECT" | "USER" | "BUILTIN" | null;
            projectAlias?: string | null;
            /** @enum {string|null} */
            status?: "ACTIVE" | "DISABLED" | "REVOKED" | "NEEDS_METADATA" | null;
            /** Format: int64 */
            revision?: number | null;
            currentVersion?: components["schemas"]["SkillVersionView"];
            versions?: components["schemas"]["SkillVersionView"][];
            diagnostics?: components["schemas"]["SkillDiagnostic"][];
            /** @description Advisory only; never an approval grant. */
            permissionHints?: string[];
            createdAt?: string | null;
            updatedAt?: string | null;
        };
        SkillVersionListResponse: {
            items?: components["schemas"]["SkillVersionView"][];
        };
        SkillManifestFile: {
            /** @description Package-relative path; never a host path. */
            path?: string | null;
            sha256?: string | null;
            /** Format: int64 */
            bytes?: number | null;
            /** @enum {string|null} */
            kind?: "ENTRY" | "REFERENCE" | "SCRIPT" | "ASSET" | "OTHER" | null;
        };
        SkillManifestResponse: {
            skillId?: string | null;
            versionId?: string | null;
            packageDigest?: string | null;
            frontmatter?: {
                [key: string]: unknown;
            } | null;
            files?: components["schemas"]["SkillManifestFile"][];
        };
        SkillImportSourceRequest: {
            /**
             * @description Opaque handle text produced by the trusted main-process
             *     directory picker — NOT a renderer-supplied path. The host
             *     re-validates the canonical root before scanning.
             */
            rootHint: string;
            displayName?: string | null;
        };
        SkillImportSourceResponse: {
            /** @description Short-lived opaque handle bound to principal/purpose. */
            sourceHandle?: string | null;
            expiresAt?: string | null;
            rootDigest?: string | null;
        };
        SkillImportPreviewRequest: {
            sourceHandle: string;
        };
        SkillImportPreviewEntry: {
            name?: string | null;
            description?: string | null;
            relativePath?: string | null;
            fileCount?: number | null;
            /** Format: int64 */
            totalBytes?: number | null;
            scriptPaths?: string[];
            permissionHints?: string[];
            diagnostics?: components["schemas"]["SkillDiagnostic"][];
        };
        SkillImportPreviewResponse: {
            previewId?: string | null;
            sourceDigest?: string | null;
            entries?: components["schemas"]["SkillImportPreviewEntry"][];
            expiresAt?: string | null;
        };
        SkillImportRequest: {
            previewId: string;
            /** @description Re-validated against the live root; mismatch means the tree changed after preview. */
            expectedSourceDigest: string;
            /** @enum {string} */
            scope: "PROJECT" | "USER";
            projectAlias?: string | null;
            /** @description Optional rename for same-name disambiguation. */
            name?: string | null;
        };
        SkillVersionSelectRequest: {
            versionDigest: string;
            /** Format: int64 */
            expectedRevision: number;
        };
        /**
         * @description Frozen per-execution binding evidence (extension design §4.2).
         *     Records what was selected and loaded; not a claim the model obeyed.
         */
        ExtensionBindingView: {
            bindingId?: string | null;
            executionId?: string | null;
            /** Format: int64 */
            revision?: number | null;
            snapshotDigest?: string | null;
            createdAt?: string | null;
            servers?: {
                serverId?: string | null;
                toolIds?: string[];
                catalogDigest?: string | null;
            }[];
            skills?: {
                skillId?: string | null;
                versionDigest?: string | null;
                /** @enum {string|null} */
                state?: "DISCOVERED" | "SELECTED" | "LOADED" | "INCLUDED" | "FAILED" | null;
                selectionReason?: string | null;
                includedRequestId?: string | null;
            }[];
        };
        ExecutionExtensionsResponse: {
            executionId?: string | null;
            binding?: components["schemas"]["ExtensionBindingView"];
            /** @description Start cursor for the extension-invocations listing. */
            invocationsCursor?: string | null;
        };
        /**
         * @description One governed extension call. UNKNOWN means the external effect could
         *     not be confirmed; it is never silently retried (design §7.2).
         */
        ExtensionInvocationView: {
            invocationId?: string | null;
            executionId?: string | null;
            bindingId?: string | null;
            /** Format: int64 */
            bindingRevision?: number | null;
            /** @enum {string|null} */
            kind?: "MCP_TOOL" | "SKILL_SCRIPT" | "MCP_RESOURCE" | "MCP_PROMPT" | null;
            target?: {
                serverId?: string | null;
                toolId?: string | null;
                skillId?: string | null;
                scriptPath?: string | null;
            } | null;
            /** @enum {string|null} */
            state?: "PREPARED" | "WAITING_APPROVAL" | "AUTHORIZED" | "DISPATCHING" | "WAITING_INPUT" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED" | "DENIED" | null;
            /** @enum {string|null} */
            effectOutcome?: "NONE" | "CONFIRMED" | "POSSIBLE" | "UNSPECIFIED" | null;
            approvalId?: string | null;
            result?: {
                contentRef?: string | null;
                contentDigest?: string | null;
                /** @description Redacted, bounded result preview. */
                preview?: string | null;
                truncated?: boolean | null;
            } | null;
            evidence?: {
                modelRequestId?: string | null;
                providerToolCallId?: string | null;
            } | null;
            errorCode?: string | null;
            attempts?: number | null;
            createdAt?: string | null;
            updatedAt?: string | null;
        };
        ExtensionInvocationListResponse: {
            items?: components["schemas"]["ExtensionInvocationView"][];
            nextCursor?: string | null;
        };
        ExtensionInvocationActionRequest: {
            /**
             * @description CANCEL settles the invocation with its honest effect outcome; RESUME_INPUT answers a parked WAITING_INPUT call; RECONCILE re-reads the durable row and attempt evidence only.
             * @enum {string}
             */
            action: "CANCEL" | "RESUME_INPUT" | "RECONCILE";
            /** @description RESUME_INPUT answers (MRTR form/choice/text payload). */
            input?: {
                [key: string]: unknown;
            } | null;
        };
        ExtensionTestExecutionRequest: {
            extensions: components["schemas"]["ExtensionSelection"];
            /** @description Optional session the test execution reports against. */
            sessionId?: string | null;
            /** @description Tool arguments for the test call — validated against the bound tool's inputSchema exactly like a model-driven invocation. */
            arguments?: {
                [key: string]: unknown;
            } | null;
            /** @description Optional context budget override for the test run. */
            budgetTokens?: number | null;
        };
        ExtensionTestExecutionResponse: {
            executionId?: string | null;
            /** @enum {string|null} */
            status?: "RUNNING" | "COMPLETED" | "FAILED" | null;
            bindingId?: string | null;
        };
        /**
         * @description Public-safe hook summary (EW10.6). Command, argument and environment
         *     configuration of the operator allowlist never leaves the service.
         */
        HookSummary: {
            name?: string | null;
            /** @enum {string|null} */
            event?: "RUN_QUEUED" | "RUN_STARTED" | "RUN_TERMINAL" | null;
            enabled?: boolean | null;
            timeoutMillis?: number | null;
            /** @enum {string|null} */
            failurePolicy?: "LOG_ONLY" | "IGNORE" | null;
            /** @enum {string|null} */
            lastStatus?: "OK" | "FAILED" | "TIMEOUT" | null;
            lastFinishedAt?: string | null;
        };
        /** @description Status, duration and identity only — never hook stdin, stdout or host details. */
        HookExecutionRecord: {
            hookName?: string | null;
            event?: string | null;
            eventId?: string | null;
            /** @enum {string|null} */
            status?: "OK" | "FAILED" | "TIMEOUT" | "SKIPPED" | null;
            /** Format: int64 */
            durationMillis?: number | null;
            finishedAt?: string | null;
        };
        HookExecutionListResponse: {
            items?: components["schemas"]["HookExecutionRecord"][];
            /** @description True when older executions were dropped by the bounded ring. */
            truncated?: boolean;
        };
        SessionForkRequest: {
            /** Format: int64 */
            expectedSessionVersion: number;
            /** @enum {string} */
            copyPolicy?: "MESSAGES_ONLY" | "MESSAGES_AND_SETTINGS" | "MESSAGES_ONLY_READ_ONLY" | "FORK_SNAPSHOT";
            title?: string | null;
            reason?: string | null;
            forkPoint?: {
                messageId?: string | null;
                eventId?: string | null;
            } | null;
        };
        SessionArchiveRequest: {
            /** Format: int64 */
            expectedSessionVersion: number;
            reason?: string | null;
        };
        /** @description Lightweight session row (2026-09-05 history pagination design §5.2); never a SessionResponse subclass. */
        SessionSummaryResponse: {
            sessionId: string;
            /** Format: int64 */
            sessionVersion: number;
            /** @description Session read-model version, decimal string */
            readRevision: string;
            title?: string | null;
            workspaceAlias?: string | null;
            agentProfileId?: string | null;
            agentProfileName?: string | null;
            agentProfileRevision?: string | null;
            status: string;
            interactionMode: string;
            /** @enum {string|null} */
            intent?: "ASK" | "REVIEW" | "EXPLAIN" | "DESIGN" | "IMPLEMENT" | null;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            updatedAt: number;
            /** Format: int64 */
            archivedAt?: number | null;
            activeRunId?: string | null;
            /** @enum {string} */
            activeRunObservation: "KNOWN" | "UNKNOWN";
            /** Format: int64 */
            eventCursor: number;
            environment?: components["schemas"]["SessionEnvironmentSection"];
        };
        SessionSummaryPageResponse: {
            /** @enum {string} */
            schemaVersion: "session-summary-page/1";
            serviceInstanceId: string;
            items: components["schemas"]["SessionSummaryResponse"][];
            /** @description Opaque signed token; null exactly when enumeration ended */
            nextCursor: string | null;
            hasMore: boolean;
            /** @description Read version validated for THIS page; not an MVCC snapshot */
            snapshotRevision: string;
            /** @enum {string} */
            consistency: "REVISION_VALIDATED";
        };
        /** @description Session contract/status projection without a messages field. */
        SessionMetadataResponse: {
            schemaVersion?: string | null;
            sessionId: string;
            /** Format: int64 */
            sessionVersion: number;
            title?: string | null;
            workspaceAlias?: string | null;
            workspaceId?: string | null;
            workspaceLineageId?: string | null;
            agentProfileId?: string | null;
            agentProfileName?: string | null;
            agentProfileRevision?: string | null;
            interactionMode: string;
            /** @enum {string|null} */
            intent?: "ASK" | "REVIEW" | "EXPLAIN" | "DESIGN" | "IMPLEMENT" | null;
            executionMode?: string;
            autonomyLevel?: string;
            /**
             * @description Independent session permission contract; FULL_ACCESS is not an interaction mode.
             * @enum {string|null}
             */
            permissionMode?: "WORKSPACE" | "FULL_ACCESS" | null;
            policyFingerprint?: string | null;
            /** Format: int64 */
            contextRevision?: number;
            parentSessionId?: string | null;
            forkPointMessageId?: string | null;
            forkPointEventId?: string | null;
            forkReason?: string | null;
            activeRunId?: string | null;
            pendingCommandApproval?: components["schemas"]["PendingCommandApproval"];
            /** @enum {string} */
            activeRunObservation: "KNOWN" | "UNKNOWN";
            status: string;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            updatedAt: number;
            /** Format: int64 */
            archivedAt?: number | null;
            writeAllow?: string[];
            writeForbid?: string[];
            contextDirectories?: string[];
            /** @enum {integer} */
            directoryPolicyVersion?: 1 | 2;
            directories?: components["schemas"]["SessionDirectory"][];
            directoryAccess?: components["schemas"]["DirectoryAccess"];
            verificationLevel?: string;
            maxModelTurns?: number;
            maxEditAttempts?: number;
            /** Format: int64 */
            eventCursor: number;
            modelAlias?: string | null;
            readRevision: string;
            transcriptRevision: string;
        };
        /** @description Verbatim persisted execution record (schema execution/1) plus embedded command records. Terminal records carry outcome and a receipt whose evidenceState distinguishes COMPLETE / PARTIAL / UNAVAILABLE / EXPIRED evidence from the process outcome itself. Expired tombstones keep expiredAt + expiredReason. */
        SessionExecutionRecord: {
            executionId: string;
            /** @enum {string} */
            kind: "BUILD" | "VERIFICATION" | "PROCESS" | "SHELL" | "PTY" | "SANDBOX_EXEC";
            toolId?: string | null;
            sessionId?: string | null;
            runId?: string | null;
            /** @description RECEIVED | VALIDATED | PLANNED | WAITING_APPROVAL | STARTED | RUNNING | COMPLETED | FAILED | CANCELLED | INTERRUPTED | REJECTED | BLOCKED | DRY_RUN */
            state: string;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            expiredAt?: number | null;
            expiredReason?: string | null;
            outcome?: {
                [key: string]: unknown;
            } | null;
            receipt?: {
                [key: string]: unknown;
            } | null;
            commandRecords?: {
                [key: string]: unknown;
            }[];
            transitions?: {
                state?: string;
                detail?: string | null;
            }[];
            executionsRoot?: string | null;
        } & {
            [key: string]: unknown;
        };
        SessionExecutionPage: {
            sessionId: string;
            executions: components["schemas"]["SessionExecutionRecord"][];
            count: number;
            nextCursor?: string | null;
            executionsRoot?: string | null;
        };
        SessionExecutionArtifactSlice: {
            executionId: string;
            path: string;
            content: string;
            /** Format: int64 */
            offset: number;
            /** Format: int64 */
            totalBytes: number;
            hasMore: boolean;
        };
        AttachmentSummaryResponse: {
            id?: string | null;
            name?: string | null;
            /**
             * @description Attachment kind since inputVersion=2 (multimodal design 7.3); null on legacy rows.
             * @enum {string|null}
             */
            kind?: "TEXT" | "IMAGE" | null;
            mediaType?: string | null;
            /** Format: int64 */
            sizeBytes?: number | null;
            sha256?: string | null;
            /** @description IMAGE only; decoded pixel width. */
            width?: number | null;
            /** @description IMAGE only; decoded pixel height. */
            height?: number | null;
        };
        SessionDirectory: {
            id: string;
            path: string;
            writeEnabled: boolean;
        };
        DirectoryAccess: {
            /** Format: int64 */
            savedSessionVersion?: number;
            /** @enum {string} */
            savedWriteMode?: "NONE" | "ROOTS" | "ALL";
            entries?: components["schemas"]["DirectoryAccessEntry"][];
            activeTurn?: components["schemas"]["DirectoryAccessActiveTurn"];
        };
        DirectoryAccessEntry: {
            id?: string;
            writable?: boolean;
            /** @enum {string} */
            reason?: "DIRECT" | "ANCESTOR" | "READ_ONLY_SESSION" | "NOT_GRANTED" | "FULL_ACCESS" | "DEFAULT_WORKSPACE";
            immutable?: boolean;
            coveredByDirectoryId?: string | null;
        };
        DirectoryAccessActiveTurn: {
            runId?: string;
            /** Format: int64 */
            sessionVersion?: number;
            /** @enum {string} */
            writeMode?: "NONE" | "ROOTS" | "ALL";
            scopeHash?: string;
        };
        SessionHistoryMessageResponse: {
            id: string;
            clientMessageId: string;
            role: string;
            status: string;
            taskId?: string | null;
            runId?: string | null;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            updatedAt: number;
            /** @description Independent revision of THIS body, decimal string */
            contentRevision: string;
            /** @description Present only when contentState=INLINE */
            content?: string | null;
            /** @description Present only when contentState=DEFERRED */
            contentPreview?: string | null;
            /** @enum {string} */
            contentState: "INLINE" | "DEFERRED";
            /** Format: int64 */
            contentBytes: number;
            /**
             * @description Provider-returned display reasoning for this assistant turn
             *     (design 2026-09-18). Bounded plain text; absent when the
             *     provider returned none or the turn predates the feature.
             *     Run-scoped turns carry reasoning on /runs/{runId}/reasoning.
             */
            reasoning?: string | null;
            /** @description True when the stored reasoning hit a capture bound */
            reasoningTruncated?: boolean | null;
            attachments?: components["schemas"]["AttachmentSummaryResponse"][];
        };
        SessionMessagePageResponse: {
            /** @enum {string} */
            schemaVersion: "session-message-page/1";
            sessionId: string;
            transcriptRevision: string;
            items: components["schemas"]["SessionHistoryMessageResponse"][];
            beforeCursor: string | null;
            afterCursor: string | null;
            hasOlder: boolean;
            /** @description False on a fresh tail page only for this transcriptRevision */
            hasNewer: boolean;
            /** @description This page's declared range was delivered whole; not a whole-transcript claim */
            rangeComplete: boolean;
        };
        MessageContentPageResponse: {
            /** @enum {string} */
            schemaVersion: "message-content-page/1";
            sessionId: string;
            messageId: string;
            contentRevision: string;
            text: string;
            nextCursor: string | null;
            hasMore: boolean;
            complete: boolean;
            /** Format: int64 */
            totalBytes: number;
        };
        SessionResponse: {
            /** @enum {string} */
            sessionPurpose?: "MAIN" | "AUXILIARY_READ_ONLY" | "DELEGATED_WRITE_CANDIDATE";
            schemaVersion?: string;
            sessionId: string;
            /** Format: int64 */
            sessionVersion: number;
            title?: string | null;
            workspaceAlias?: string | null;
            workspaceId?: string | null;
            workspaceLineageId?: string | null;
            agentProfileId?: string | null;
            agentProfileName?: string | null;
            agentProfileRevision?: string | null;
            /** @enum {string|null} */
            readonlyResearchMode?: "AUTO" | "OFF" | null;
            readonlyResearchEnabled?: boolean | null;
            readonlyResearchReasonCode?: string | null;
            initialWorkspaceListing?: boolean | null;
            interactionMode?: string | null;
            /** @enum {string|null} */
            intent?: "ASK" | "REVIEW" | "EXPLAIN" | "DESIGN" | "IMPLEMENT" | null;
            executionMode?: string | null;
            autonomyLevel?: string | null;
            /**
             * @description Independent contract override. FULL_ACCESS is not a third interaction mode.
             * @enum {string|null}
             */
            permissionMode?: "WORKSPACE" | "FULL_ACCESS" | null;
            modelAlias?: string | null;
            /** Format: int64 */
            modelSettingsRevision?: number;
            /** @enum {string} */
            modelSettingsState?: "READY" | "PENDING" | "PREPARING" | "APPLIED" | "FAILED";
            modelSettings?: components["schemas"]["SessionModelSettings"];
            policyFingerprint?: string | null;
            /** Format: int64 */
            contextRevision?: number;
            parentSessionId?: string | null;
            forkPointMessageId?: string | null;
            forkPointEventId?: string | null;
            forkReason?: string | null;
            activeRunId?: string | null;
            pendingCommandApproval?: components["schemas"]["PendingCommandApproval"];
            status?: string | null;
            /** Format: int64 */
            createdAt?: number;
            /** Format: int64 */
            updatedAt?: number;
            /** Format: int64 */
            archivedAt?: number | null;
            writeAllow?: string[];
            writeForbid?: string[];
            contextDirectories?: string[];
            /** @enum {integer} */
            directoryPolicyVersion?: 1 | 2;
            directories?: components["schemas"]["SessionDirectory"][];
            directoryAccess?: components["schemas"]["DirectoryAccess"];
            verificationLevel?: string | null;
            maxModelTurns?: number;
            maxEditAttempts?: number;
            workspaceBinding?: components["schemas"]["WorkspaceBindingResponse"];
            messages?: {
                id?: string;
                clientMessageId?: string | null;
                role?: string;
                content?: string;
                status?: string | null;
                taskId?: string | null;
                runId?: string | null;
                /**
                 * @description Provider-returned display reasoning for ordinary-chat
                 *     assistant turns (design 2026-09-18). Bounded public text
                 *     only; run-scoped turns carry reasoning on
                 *     /runs/{runId}/reasoning.
                 */
                reasoning?: string | null;
                /** @description True when the stored reasoning hit a capture bound */
                reasoningTruncated?: boolean | null;
                /** @description Attachment light projection (id/name/mediaType/sizeBytes/sha256; no textContent). */
                attachments?: {
                    id?: string | null;
                    name?: string | null;
                    mediaType?: string | null;
                    /** Format: int64 */
                    sizeBytes?: number | null;
                    sha256?: string | null;
                }[] | null;
                /** Format: int64 */
                createdAt?: number;
                /** Format: int64 */
                updatedAt?: number;
            }[];
            /** Format: int64 */
            eventCursor?: number;
        };
        AttentionItem: {
            attentionId?: string;
            sourceType?: string | null;
            sourceId?: string | null;
            /** Format: int64 */
            sourceVersion?: number;
            sessionId?: string | null;
            missionId?: string | null;
            attentionType?: string | null;
            status?: string | null;
            fingerprint?: string | null;
            summary?: string | null;
            decisionEndpoint?: string | null;
            createdAt?: string | null;
            resolvedAt?: string | null;
        };
        /**
         * @description Actual wire shape of v2 problems: {code, status, message} plus
         *     flattened detail fields. The `code` is the only stable contract for
         *     UIs; `message` is human-readable diagnostics.
         */
        Problem: {
            code: string;
            status: number;
            message: string;
            failure?: components["schemas"]["FailureDescriptorResponse"];
        } & {
            [key: string]: unknown;
        };
        ExecutionBackendStatusResponse: {
            snapshotVersion: string;
            snapshotId: string;
            catalogFingerprint?: string | null;
            /** Format: int64 */
            generation: number;
            /** Format: date-time */
            observedAt?: string | null;
            /** Format: date-time */
            expiresAt?: string | null;
            reasonCode?: string | null;
            safeReason?: string | null;
            backends: {
                id: string;
                type: string;
                availability: string;
                isolationLevel: string;
                reasonCode?: string | null;
                safeReason?: string | null;
            }[];
        };
        CapabilityResponse: {
            serviceInstanceId: string;
            /** @description Stable identity of the service state store; changes only when the store is replaced. */
            storeId?: string | null;
            /** @description Process boot identity; changes on every Service restart. */
            bootId?: string | null;
            /** @example 2.1 */
            protocolVersion: string;
            /** @example 2.0 */
            minDesktopProtocol: string;
            build?: {
                business?: string | null;
                productCode?: string | null;
                productPlan?: string | null;
                framework?: string | null;
                foundation?: string | null;
            };
            features: {
                sessionV2?: boolean;
                durableEvents?: boolean;
                visibleOutputStream?: boolean;
                reviewScopes?: ("LAST_TURN" | "RUN" | "WORKING_TREE" | "STAGED" | "COMMIT" | "BRANCH")[];
                worktreeExecution?: boolean;
                mission?: boolean;
                /**
                 * @description EW10.2 read-only Web/issue/docs source adapter (design 10.9).
                 *     Off by default; enabling requires the source threat-model
                 *     gates. Fetched content is always untrusted data.
                 */
                readOnlySources?: boolean;
                /**
                 * @description EW10.3 read-only MCP resource source (design 10.6). Off by
                 *     default; servers come from the service-side allowlist only,
                 *     resources/list and resources/read only, content is always
                 *     untrusted data. Mutating MCP tools stay behind mcpHost.
                 */
                mcpReadOnlySource?: boolean;
                /**
                 * @description EW10.5 skill catalog (design 10.6). Off by default; the
                 *     catalog only registers, lists and gates skills — it never
                 *     executes them.
                 */
                skillsCatalog?: boolean;
                /**
                 * @description EW10.6 typed hooks (design 10.6). Off by default; hooks are
                 *     operator-allowlisted lifecycle observers with fixed events,
                 *     typed input, timeouts and a never-blocks-the-run failure
                 *     policy. No arbitrary implicit shell.
                 */
                hooks?: boolean;
                /**
                 * @description Read-only research/plan subagent capability. Off by default;
                 *     enabling requires the EW8 subagent contract gates.
                 */
                readOnlySubagent?: boolean;
                /**
                 * @description Service-level rollout shape for the read-only research
                 *     capability. Session/workspace eligibility is evaluated per run.
                 * @enum {string}
                 */
                readOnlySubagentAvailability?: "NONE" | "WORKSPACE_ALLOWLIST" | "ALL_ELIGIBLE_WORKSPACES";
                mcpHost?: boolean;
                servicePty?: boolean;
                /** @description Cloud Git workspace (detailed design §10.5). Off by default. */
                repositoryBinding?: boolean;
                managedClone?: boolean;
                remoteWorkspaceLane?: boolean;
                remoteFileWrite?: boolean;
                gitLocalCommit?: boolean;
                gitRemotePush?: boolean;
                pullRequestCreate?: boolean;
                signedCommit?: boolean;
                multiRepositoryLane?: boolean;
                /**
                 * @description PAE P0 joint capability (p0-contract-freeze §2): trusted
                 *     project-environment prepare is available only when the
                 *     install-side Operator channel, real bound-environment
                 *     consumption and measured readiness are all in place.
                 *     Absent/false means unsupported — no silent host fallback.
                 */
                projectEnvironmentPrepareV1?: boolean;
                /**
                 * @description PAE P0 joint capability (p0-contract-freeze §2):
                 *     executions run inside a frozen execution-environment
                 *     binding end to end. Same joint advertisement and no
                 *     fallback rules as projectEnvironmentPrepareV1.
                 */
                environmentBoundExecutionV1?: boolean;
                /**
                 * @description PAE P0 joint capability (p0-contract-freeze §2): TASK/
                 *     PROJECT adaptive action plans and trial receipts.
                 *     Same joint advertisement and no fallback rules as
                 *     projectEnvironmentPrepareV1.
                 */
                adaptiveActionV1?: boolean;
            };
            limits: {
                /** Format: int64 */
                maxDiffBytes?: number;
                maxEventPage?: number;
                maxVisibleDeltaChars?: number;
            };
            multiClient?: {
                contractVersion?: string;
                /** @enum {string} */
                mode?: "SHARED_STRICT" | "LEGACY_COMPAT" | "OWNED_PRIVATE";
                lifecycle?: string;
                registrationRequiredForMutation?: boolean;
                limits?: {
                    [key: string]: unknown;
                };
            } | null;
            /** @description Operation-level availability generated from the wired service routes. */
            operations: components["schemas"]["OperationCapability"][];
        };
        OperationCapability: {
            id: string;
            /** @enum {string} */
            availability: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
            reasonCode?: string | null;
            limits?: {
                [key: string]: unknown;
            };
            contractVersion: string;
        };
        FileReadResponse: {
            projectId: string;
            fileRef: string;
            revisionRef: string;
            mediaType: string;
            /** @enum {string} */
            encoding: "UTF-8" | "BINARY";
            contentText?: string | null;
            /** Format: int64 */
            contentBytes: number;
            sha256: string;
            truncated: boolean;
            stale: boolean;
        };
        ProjectSummary: {
            projectId: string;
            displayName?: string | null;
            workspaceAlias: string;
            vcsKind?: string | null;
            branchDisplay?: string | null;
            headShortRevision?: string | null;
            dirtySummary?: string | null;
            authorityStatus: string;
            capabilities?: string[];
            runningCount?: number;
            attentionCount?: number;
        };
        /** @description One readiness/pre-flight fact (design 2026-09-26 §7.2). */
        BuildPlanReadiness: {
            id?: string;
            check?: string;
            /** @enum {string} */
            severity?: "PASS" | "WARN" | "FAIL";
            passed?: boolean;
            inconclusive?: boolean;
            code?: string | null;
            message?: string | null;
        };
        BuildPlanActionView: {
            /** @description Resolved argv; argv[0] is the executable. */
            argv?: string[];
            runner?: string | null;
            recipeId?: string;
            /** @enum {string} */
            planSource?: "BUILTIN" | "SERVICE_CONFIG" | "WORKSPACE_SUGGESTION" | "USER_OVERRIDE" | "DETECTED";
            planFingerprint?: string;
            env?: {
                [key: string]: string;
            };
            disabled?: boolean;
            override?: boolean;
            source?: string;
            readiness?: components["schemas"]["BuildPlanReadiness"][];
        };
        BuildPlanOverrideView: {
            targetId: string;
            /**
             * @description Action key; null when the row is wildcard.
             * @enum {string|null}
             */
            action?: "COMPILE" | "TEST" | "PACKAGE" | "VERIFY" | null;
            runner?: string | null;
            argv?: string[] | null;
            env?: {
                [key: string]: string;
            } | null;
            disabled: boolean;
            source?: string;
            workspaceFingerprint?: string | null;
            /**
             * @description STALE rows are fingerprint-drifted and never applied.
             * @enum {string}
             */
            status: "ACTIVE" | "STALE";
            /** Format: int64 */
            revision?: number;
            /** Format: int64 */
            updatedAt?: number;
        };
        BuildPlanTargetView: {
            targetId: string;
            tool: string;
            /** @description Workspace-relative project directory */
            dir?: string;
            manifest?: string;
            reportKind?: string | null;
            actions: {
                [key: string]: components["schemas"]["BuildPlanActionView"];
            };
            overrides?: components["schemas"]["BuildPlanOverrideView"][];
            /** @enum {string} */
            source: "DETECTED" | "USER";
        };
        ProjectBuildPlanResponse: {
            /** Format: int64 */
            generatedAt: number;
            workspaceFingerprint?: string | null;
            recipesVersion?: string;
            recipeLoadWarnings?: string[];
            targets: components["schemas"]["BuildPlanTargetView"][];
            truncated?: boolean;
        };
        BuildPlanOverrideRequest: {
            targetId: string;
            /**
             * @description Omit or "*" for a wildcard row across all actions.
             * @enum {string}
             */
            action?: "COMPILE" | "TEST" | "PACKAGE" | "VERIFY";
            runner?: string;
            argv?: string[];
            env?: {
                [key: string]: string;
            };
            disabled?: boolean;
        };
        BuildPlanOverrideResponse: {
            workspaceFingerprint?: string | null;
            override: components["schemas"]["BuildPlanOverrideView"];
            target: components["schemas"]["BuildPlanTargetView"];
        };
        BuildPlanPreviewResponse: {
            workspaceFingerprint?: string | null;
            recipesVersion?: string;
            override: components["schemas"]["BuildPlanOverrideView"];
            target: components["schemas"]["BuildPlanTargetView"];
        };
        VerificationProfileRequest: {
            /** @description Profile intent document (steps, selectors, evidence policy, success criteria). Known keys are shape-validated; unknown keys round-trip for forward compatibility. */
            config: Record<string, never>;
            enabled?: boolean;
            /**
             * Format: int64
             * @description Body-level fallback for the If-Match header.
             */
            expectedRevision?: number;
        };
        VerificationProfileResponse: {
            projectId: string;
            profileId: string;
            /** Format: int64 */
            revision: number;
            schemaVersion: number;
            config?: Record<string, never>;
            /** @description sha256 of the normalized config; bound into plan fingerprints. */
            configDigest: string;
            enabled: boolean;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            updatedAt: number;
        };
        VerificationProfileListResponse: {
            profiles: components["schemas"]["VerificationProfileResponse"][];
        };
        /** @description Session-status environment facts (design 2026-09-26 §7.4): build targets, the toolchain rows those targets need, and the latest verification status. Facts only — never recovery or suggested-fix fields. */
        SessionEnvironmentSection: {
            /** Format: int64 */
            probedAt?: number;
            workspaceFingerprint?: string | null;
            targets: {
                targetId?: string;
                tool?: string;
                dir?: string;
                runner?: string | null;
                issue?: string | null;
            }[];
            toolchain: {
                runner?: string;
                executable?: string;
                /** @description null = inconclusive probe */
                available?: boolean | null;
            }[];
            truncated?: boolean;
            /** @description Latest verification record — status and failure code only. */
            verification?: {
                recordId?: string;
                status?: string;
                failureCode?: string | null;
                projectDirectory?: string | null;
                /** Format: int64 */
                createdAtMillis?: number;
            } | null;
        };
        ProjectStatus: {
            projectId: string;
            workspaceAlias: string;
            workspaceId?: string | null;
            headRevision?: string | null;
            fingerprint?: string | null;
            dirtyCount?: number;
            dirtyFiles?: string[];
            authorityStatus?: string;
        };
        ProjectSessionPreflight: {
            projectId: string;
            workspaceAlias: string;
            workspaceId?: string;
            headRevision?: string;
            workspaceFingerprint?: string;
            revision: string;
            policyFingerprint: string;
            authorityStatus: string;
            allowedIntents: ("ASK" | "CODE" | "PLAN")[];
            suggestedWriteScope: string[];
            writeScopeCeiling: string[];
            modelAlias?: string | null;
            modelAvailability: string | null;
            /** @description Project-scoped capabilities proven by the current workspace and policy. */
            effectiveTools?: components["schemas"]["EffectiveToolCapabilityResponse"][];
        };
        EffectiveToolCapabilityResponse: {
            toolName: string;
            capabilityId: string;
            /** @enum {string} */
            availability: "AVAILABLE" | "APPROVAL_REQUIRED" | "DEGRADED" | "UNAVAILABLE" | "UNKNOWN";
            reasonCode?: string | null;
            /**
             * Format: int32
             * @default 2
             */
            activityContractVersion: number;
            mutating: boolean;
            approvalRequired: boolean;
            constraints: {
                [key: string]: unknown;
            };
        };
        ProjectRegistrationRequest: {
            /** @description Absolute path supplied only by the Electron main. */
            absolutePath: string;
            displayName?: string | null;
        };
        ProjectRegistrationResponse: {
            projectId: string;
            workspaceAlias: string;
            displayName?: string | null;
            /** @description Only returned to the authenticated caller (the main). */
            canonicalRoot: string;
            alreadyRegistered: boolean;
        };
        NativeOpenIntent: {
            intentId: string;
            projectId: string;
            /** @enum {string} */
            action: "REVEAL" | "IDE" | "USER_TERMINAL" | "REVEAL_FILE";
            root: string;
            /** @description Server-owned file path (REVEAL_FILE only). */
            fileRef?: string | null;
            serviceInstanceId: string;
            /** Format: int64 */
            expiresAtMillis: number;
            signature: string;
        };
        /**
         * @description Public run state; unknown internal statuses map to UNKNOWN.
         * @enum {string}
         */
        RunState: "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "PAUSE_REQUESTED" | "PAUSED" | "CANCEL_REQUESTED" | "VALIDATING" | "NEEDS_ATTENTION" | "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";
        RunStateResponse: {
            runId: string;
            taskId: string;
            state: components["schemas"]["RunState"];
            /** @description Original internal status name, for UNKNOWN drift detection. */
            sourceStatus?: string | null;
            /** Format: int64 */
            stateVersion: number;
            lastEventId?: string | null;
            sessionId?: string | null;
            workspaceId?: string | null;
            workspaceAlias?: string | null;
            summary?: string | null;
            failureCode?: string | null;
            failureMessage?: string | null;
            terminationCode?: string | null;
            changedFileCount?: number;
            queuedAt?: string | null;
            startedAt?: string | null;
            finishedAt?: string | null;
            updatedAt?: string | null;
            /**
             * @description Additive V2 (causal verification design 2026-09-02 §11.3): outcome severity axis, orthogonal to state. OK/WARNING/ERROR; null on legacy runs.
             * @enum {string|null}
             */
            outcomeSeverity?: "OK" | "WARNING" | "ERROR" | null;
            /** @description Additive V2 (causal verification design 2026-09-02 §11.3): structured verification projection (overall, requiredLanesPassed, warnings, lanes). Shape is owned by the Product VerificationOutcomeV2 contract; treated as opaque here. Null on legacy runs. */
            verificationV2?: {
                [key: string]: unknown;
            } | null;
            delivery?: components["schemas"]["RunDeliveryResponse"];
            failure?: components["schemas"]["FailureDescriptorResponse"];
            /** @description Direct-workspace CAS conflicts requiring explicit resolution */
            workspaceConflicts?: components["schemas"]["WorkspaceConflictResponse"][];
            /** @description Additive V2 (design 2026-09-25 §6.5): workspace attention sub-record {reason, openCount, resolvedCount, dismissedCount, clearedAt}; clearedAt != null makes POST /runs/{id}/continue admissible. */
            attention?: {
                [key: string]: unknown;
            } | null;
            /** @description Run-id this run continues from (WU-05) */
            continuationOf?: string | null;
            /** @description Run-id of the follow-up created by POST /continue (WU-05) */
            continuedBy?: string | null;
            scheduling?: components["schemas"]["RunSchedulingResponse"];
            /** @description Durable run control marker (PAUSE_REQUESTED/RESUME_REQUESTED/STOP_REQUESTED/PAUSED/STOPPED etc.); internal vocabulary, consumers must not treat it as the public state. */
            controlState?: string | null;
            /** @description Command id of the control currently owning the transition, when present. */
            controlCommandId?: string | null;
            /** @description Whether a resumable checkpoint is stored for this run. */
            checkpointAvailable?: boolean;
            /** @description Control verbs admissible on this state as projected by the server (PAUSE/RESUME/STOP/RECOVER); authoritative admission stays with the commands endpoint. */
            availableActions?: string[];
        };
        RunSchedulingResponse: {
            schemaVersion: string;
            runId?: string | null;
            /** @enum {string|null} */
            state?: "ACCEPTED" | "ELIGIBLE" | "CLAIMING_RESOURCES" | "DISPATCH_PENDING" | "DISPATCHED" | "SUSPENDED" | "RECOVERING" | "TERMINAL" | null;
            primaryReason?: string | null;
            secondaryReasons?: string[];
            /** Format: int32 */
            queuePosition?: number | null;
            approximate: boolean;
            admittedAt?: string | null;
            eligibleAt?: string | null;
            lastProgressAt?: string | null;
            executionMode?: string | null;
            workspaceRef?: string | null;
            activeClaims?: string[];
        };
        SchedulerOverviewResponse: {
            schemaVersion: string;
            bootId?: string | null;
            schedulerMode?: string | null;
            recoveryBarrier?: string | null;
            provenanceFingerprint?: string | null;
            configFingerprint?: string | null;
            /** Format: int32 */
            activeRuns: number;
            /** Format: int32 */
            maxActiveRuns: number;
            /** Format: int32 */
            queuedRuns: number;
            resourcePools: {
                [key: string]: unknown;
            }[];
        };
        FailureDescriptorResponse: {
            schemaVersion: string;
            code: string;
            /** @enum {string} */
            domain: "MODEL_AUTH" | "MODEL_RATE_LIMIT" | "MODEL_TRANSPORT" | "MODEL_PROTOCOL" | "CONTEXT" | "TOOL_INPUT" | "TOOL_EXECUTION" | "WORKSPACE_SCOPE" | "PERMISSION" | "BUDGET" | "VERIFICATION" | "SERVICE_TRANSPORT" | "CLIENT_PROTOCOL" | "ENVIRONMENT" | "INTERNAL";
            /** @enum {string} */
            phase: "ADMISSION" | "PREPARE" | "REQUEST" | "RECEIVE" | "VALIDATE" | "EXECUTE" | "VERIFY" | "PERSIST" | "PROJECT" | "DELIVER";
            /** @enum {string} */
            disposition: "AUTO_RECOVERING" | "USER_ACTION_REQUIRED" | "OPERATOR_ACTION_REQUIRED" | "TERMINAL";
            /** @enum {string} */
            effectState: "NOT_APPLIED" | "APPLIED" | "UNKNOWN";
            safeMessage?: string | null;
            recovery: components["schemas"]["RecoveryDirectiveResponse"];
            context?: {
                [key: string]: unknown;
            } | null;
            causes?: {
                [key: string]: unknown;
            }[];
        };
        RecoveryDirectiveResponse: {
            /** @enum {string} */
            mode: "NONE" | "MODEL_REPAIR_INPUT" | "NEW_MODEL_ATTEMPT" | "RESUME_CHECKPOINT" | "RETRY_OPERATION" | "RECONCILE_THEN_RETRY";
            /** @enum {string} */
            actor: "RUNTIME" | "MODEL" | "USER" | "OPERATOR";
            automatic: boolean;
            sameInputAllowed: boolean;
            /** Format: int32 */
            attemptsUsed: number;
            /** Format: int32 */
            maxAttempts: number;
            /** Format: int64 */
            retryAfterMillis?: number | null;
            checkpointRef?: string | null;
            reconcileRef?: string | null;
            actionIds?: string[];
        };
        RunDeliveryResponse: {
            /** @enum {string} */
            status?: "PENDING" | "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
            artifactsReady?: boolean;
            /** Format: int64 */
            stateVersion?: number;
            changeArtifactRef?: string | null;
            evidenceManifestRef?: components["schemas"]["EvidenceManifestRef"];
        };
        RunListResponse: {
            items: components["schemas"]["RunStateResponse"][];
            truncated: boolean;
        };
        RunControlRequest: {
            /** @enum {string} */
            intent: "PAUSE" | "RESUME" | "STOP" | "RECOVER";
            /** Format: int64 */
            expectedStateVersion?: number | null;
            reasonCode?: string | null;
        };
        /** @description expectedStateVersion is required for PAUSE and RESUME; STOP accepts a stale version. commandId equals Idempotency-Key. */
        RunCommandRequest: {
            /** @enum {string} */
            schemaVersion: "run-command/1";
            commandId: string;
            /** @enum {string} */
            intent: "PAUSE" | "RESUME" | "STOP";
            /** Format: int64 */
            expectedStateVersion?: number | null;
            reasonCode?: string | null;
        };
        RunCommandReceipt: {
            /** @enum {string} */
            schemaVersion: "run-command-receipt/1";
            commandId: string;
            receiptId: string;
            sessionId?: string | null;
            runId: string;
            /** @enum {string} */
            intent: "PAUSE" | "RESUME" | "STOP";
            reasonCode?: string | null;
            /** @enum {string} */
            phase: "ACCEPTED" | "DISPATCHING" | "REQUESTED" | "APPLIED" | "NOOP" | "REJECTED" | "UNKNOWN" | "SUPERSEDED";
            receiptRevision: string;
            /** Format: date-time */
            acceptedAt: string;
            actor: {
                principalId: string;
                clientSessionId: string;
            };
            /** Format: int64 */
            expectedStateVersion?: number | null;
            /** Format: int64 */
            acceptedStateVersion: number;
            /** Format: int64 */
            observedStateVersion: number;
            observedRunState: string;
            resultCode?: string | null;
            terminal: boolean;
            evidenceRef?: string | null;
            consumptionProof?: {
                [key: string]: string;
            } | null;
        };
        RunCommandPage: {
            items: components["schemas"]["RunCommandReceipt"][];
            nextBefore?: string | null;
        };
        RunInterruptRequest: {
            /** Format: int64 */
            expectedStateVersion?: number | null;
        };
        RunContinueRequest: {
            /** Format: int64 */
            expectedStateVersion?: number | null;
            /** @description Optional operator note appended to the continuation system frame */
            message?: string | null;
        };
        RunActivityTargetResponse: {
            /** @description Project-relative target ref; never an absolute path. */
            ref: string;
            /** @enum {string} */
            status: "REQUESTED" | "SUCCEEDED" | "FAILED" | "PARTIAL" | "UNKNOWN";
        };
        RunActivityResponse: {
            /** Format: int32 */
            activityContractVersion?: number | null;
            /** Format: int64 */
            activitySequence?: number | null;
            activityId: string;
            runId: string;
            /**
             * Format: int32
             * @description Child attempt number used for replay-safe delegation status.
             */
            attempt?: number | null;
            /**
             * Format: int64
             * @description Event timestamp/version of the authoritative child outcome.
             */
            outcomeVersion?: number | null;
            /** @description Model-interaction round key (design 2026-09-19 §5.1): the Product logical model-call id shared by every product of one call. Absent on legacy or runtime-owned items; never inferred. */
            roundId?: string | null;
            /**
             * Format: int32
             * @description Optional 1-based round order inside the run.
             */
            roundOrdinal?: number | null;
            /** @description Stable activity kind (FILE_READ, CODE_SEARCH, COMMAND, BUILD, GIT, ...). */
            kind: string;
            /** @description RUNNING / SUCCEEDED / PARTIAL / FAILED / TIMED_OUT / REJECTED / CANCELLED / WAITING_APPROVAL / ABORTED / UNKNOWN. */
            status: string;
            toolName?: string | null;
            capabilityId?: string | null;
            detail?: string | null;
            /** @description Redacted, bounded command preview; never raw arguments. */
            commandPreview?: string | null;
            /** @enum {string} */
            redactionState?: "NONE" | "REDACTED" | "WITHHELD";
            targets?: components["schemas"]["RunActivityTargetResponse"][];
            startedAt?: string | null;
            finishedAt?: string | null;
            /** Format: int64 */
            durationMillis?: number | null;
            resultSummary?: string | null;
            reasonCode?: string | null;
            failure?: components["schemas"]["FailureDescriptorResponse"];
            truncated?: boolean | null;
            /** Format: int64 */
            startCursor?: number;
            /** Format: int64 */
            endCursor?: number;
            /** @enum {string|null} */
            statusOrigin?: "PERSISTED" | "DERIVED" | null;
            /** @description Execution-evidence reference (design 2026-09-26 WU-1): the journaled execution id resolvable through GET /sessions/{sessionId}/executions/{executionId}. Identifier only — this response never carries stdout/stderr or artifact bytes. Absent on legacy events or capabilities without evidence. */
            executionId?: string | null;
            /** @description Command id inside the execution record, when the result names one. */
            commandId?: string | null;
            /** @description Evidence record state reported by the capability (e.g. EXECUTED). */
            evidenceState?: string | null;
            /** @description Record-relative artifact paths (e.g. artifacts/cmd-001.stdout.log) fetchable as bounded slices through the session execution artifact endpoint. */
            evidenceArtifacts?: string[] | null;
        };
        RunActivitySummaryResponse: {
            /** @enum {string} */
            completeness: "LIVE_LOWER_BOUND" | "TERMINAL_EXACT" | "INCOMPLETE";
            activityCount: number;
            runningCount?: number;
            succeededCount?: number;
            partialCount?: number;
            failedCount?: number;
            uniqueReadFileCount?: number;
            uniqueWrittenFileCount?: number;
            commandCount?: number;
            startedAt?: string | null;
            finishedAt?: string | null;
            updatedAt?: string | null;
            /** Format: int64 */
            sourceCursor?: number;
            productSequenceGap?: boolean | null;
            /** Format: int32 */
            activityContractVersion?: number | null;
            /** Format: int64 */
            firstActivitySequence?: number | null;
            /** Format: int64 */
            lastActivitySequence?: number | null;
            /** Format: int64 */
            expectedLastActivitySequence?: number | null;
            activitySequenceGap?: boolean | null;
            orphanActivityCount?: number | null;
            unknownActivityCount?: number | null;
            projectionFailureCount?: number | null;
            deliveryFailureCount?: number | null;
            capabilityCounts?: components["schemas"]["RunActivityCapabilityCountResponse"][];
        };
        RunActivityCapabilityCountResponse: {
            capabilityId: string;
            startedCount: number;
            succeededCount: number;
            failedCount: number;
        };
        RunActivityListResponse: {
            /** Format: int32 */
            activityContractVersion?: number | null;
            runId: string;
            /** Format: int64 */
            runStateVersion: number;
            /** Format: int64 */
            snapshotCursor: number;
            /** Format: int64 */
            retentionFloor?: number;
            complete: boolean;
            reasonCode?: string | null;
            truncated?: boolean;
            items: components["schemas"]["RunActivityResponse"][];
            summary: components["schemas"]["RunActivitySummaryResponse"];
        };
        RunReasoningResponse: {
            runId: string;
            /** Format: int64 */
            runStateVersion: number;
            /** Format: int64 */
            snapshotCursor: number;
            /** Format: int64 */
            retentionFloor?: number;
            /** @description Assembled display reasoning in relay sequence order; bounded */
            text: string;
            /** Format: int64 */
            receivedBytes: number;
            /**
             * Format: int64
             * @description Bytes the relay accepted, including parts dropped by rate limiting or truncation
             */
            totalBytes: number;
            /** Format: int64 */
            droppedChunks: number;
            /** Format: int64 */
            lastSequence: number;
            /** @description True when the run is terminal; text is then the authoritative end state */
            terminal: boolean;
            complete: boolean;
            /** @description TERMINAL_EXACT / LIVE_LOWER_BOUND / INCOMPLETE machine reason */
            reasonCode?: string | null;
            /** @description True when the assembled text hit the response-side bound */
            truncated: boolean;
            /** @description Per-round display reasoning (design 2026-09-19 §5.4). Empty when no frame carried a round key; the run-level text stays the authoritative aggregate for legacy consumers. */
            segments?: components["schemas"]["RunReasoningSegmentResponse"][];
        };
        RunReasoningSegmentResponse: {
            /** @description Product logical model-call id shared by the round's frames. */
            roundId: string;
            /**
             * Format: int32
             * @description Optional 1-based round order inside the run.
             */
            roundOrdinal?: number | null;
            /** @description Assembled display reasoning for this round; bounded. */
            text: string;
            /** @description True when this segment hit the response-side text bound. */
            truncated: boolean;
            /** @description True when the segment is provably complete for the data retained (round-local honesty combined with the stream-level verdict). */
            complete: boolean;
            /**
             * Format: int64
             * @description Highest frame sequence contributing to this segment.
             */
            lastSequence: number;
        };
        RunOutputResponse: {
            runId: string;
            /** Format: int64 */
            runStateVersion: number;
            /** Format: int64 */
            snapshotCursor: number;
            /** Format: int64 */
            retentionFloor?: number;
            /** @description Assembled visible output in relay sequence order; bounded */
            text: string;
            /** Format: int64 */
            receivedBytes: number;
            /**
             * Format: int64
             * @description Bytes the relay accepted, including parts dropped by rate limiting or truncation
             */
            totalBytes: number;
            /** Format: int64 */
            droppedChunks: number;
            /** Format: int64 */
            lastSequence: number;
            /** @description True when the run is terminal; text is then the authoritative end state */
            terminal: boolean;
            complete: boolean;
            /** @description TERMINAL_EXACT / LIVE_LOWER_BOUND / INCOMPLETE machine reason */
            reasonCode?: string | null;
            /** @description True when the assembled text hit the response-side bound */
            truncated: boolean;
            /** @description Per-round visible output (design 2026-09-19 §5.5-B). Empty when no frame carried a round key; the run-level text stays the authoritative aggregate for legacy consumers. */
            segments?: components["schemas"]["RunOutputSegmentResponse"][];
        };
        RunOutputSegmentResponse: {
            /** @description Product logical model-call id shared by the round's frames. */
            roundId: string;
            /**
             * Format: int32
             * @description Optional 1-based round order inside the run.
             */
            roundOrdinal?: number | null;
            /** @description Assembled visible output for this round; bounded. */
            text: string;
            /** @description True when this segment hit the response-side text bound. */
            truncated: boolean;
            complete: boolean;
            /**
             * Format: int64
             * @description Highest frame sequence contributing to this segment.
             */
            lastSequence: number;
        };
        /** @enum {string} */
        EvidenceLayer: "SOURCE" | "DETERMINISTIC_TEST" | "PACKAGE" | "RUNTIME" | "LIVE_MODEL" | "TRACE" | "GUI" | "SCENARIO_ORACLE" | "EXECUTION_ACTIVITY";
        /** @enum {string} */
        EvidenceStatus: "PRESENT" | "NOT_RUN" | "FAILED" | "INCOMPLETE" | "NOT_APPLICABLE";
        EvidenceItemResponse: {
            evidenceId: string;
            layer: components["schemas"]["EvidenceLayer"];
            status: components["schemas"]["EvidenceStatus"];
            summary?: {
                [key: string]: unknown;
            };
        };
        EvidenceBundleResponse: {
            runId: string;
            generatedAt: string;
            /** @description True only when every layer is PRESENT or NOT_APPLICABLE. */
            complete: boolean;
            items: components["schemas"]["EvidenceItemResponse"][];
            /** Format: int64 */
            stateVersion?: number | null;
            artifactsReady?: boolean | null;
            /** @enum {string|null} */
            deliveryStatus?: "PENDING" | "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | null;
            changeArtifactRef?: string | null;
            manifestRef?: components["schemas"]["EvidenceManifestRef"];
            verificationV2?: {
                [key: string]: unknown;
            } | null;
            /** @enum {string|null} */
            outcomeSeverity?: "OK" | "WARNING" | "ERROR" | null;
        };
        EvidenceManifestRef: {
            manifestId?: string;
            sha256?: string;
            /** Format: int64 */
            stateVersion?: number;
        };
        ModelCatalogEntry: {
            providerId?: string | null;
            protocol?: string | null;
            providerDisplayName?: string | null;
            modelAlias: string;
            capabilities?: string[];
            maxContextLevel?: string | null;
            /**
             * Format: int64
             * @description Physical model context window in tokens.
             */
            contextWindowTokens?: number | null;
            /**
             * Format: int64
             * @description Latest prompt size reported by the model service.
             */
            contextUsedTokens?: number | null;
            /**
             * Format: double
             * @description Average cached-input ratio reported by the model service, as a percentage.
             */
            cacheHitRatePercent?: number | null;
            /**
             * Format: int64
             * @description Number of model responses contributing to the in-memory usage projection.
             */
            usageSampleCount?: number | null;
            /** @description Selectable context budgets declared by the model; clients must not submit arbitrary token values. */
            contextTokenOptions?: number[];
            reasoningEffortOptions?: string[];
            configured: boolean;
            routePolicyName?: string | null;
            /** @enum {string} */
            availability: "AVAILABLE" | "UNCONFIGURED" | "UNAVAILABLE";
        };
        ModelCatalogResponse: {
            defaultModel?: string | null;
            items: components["schemas"]["ModelCatalogEntry"][];
        };
        /** @description MA-001 MA04 authority snapshot. Secret-free by construction. */
        ModelCatalogAuthorityResponse: {
            /** @enum {string} */
            source: "LOCAL" | "ENTERPRISE_HTTP" | "FILE_COMPAT" | "UNKNOWN";
            /** @description Secret-free source label, e.g. mrel-...@41. */
            sourceIdentity?: string | null;
            capabilities?: {
                managedCatalogWrite?: boolean;
                enterpriseSync?: boolean;
            };
            applied: {
                releaseId?: string | null;
                /** Format: int64 */
                generation?: number | null;
                authorityId?: string | null;
                profileId?: string | null;
                consumerSnapshotDigest?: string | null;
                projectionFingerprint?: string | null;
                loadedAt?: string | null;
                readiness?: string | null;
                catalogError?: string | null;
            };
            /**
             * @description Enterprise poll posture; state=NOT_APPLICABLE for
             *     non-enterprise sources. revocationChannel honestly states
             *     what the negotiated wire version can express:
             *     CONSUMER_V2 (binding ids + validity horizons) or
             *     RELEASE_WITHDRAWAL_ONLY (v1 head).
             */
            sync: {
                enabled?: boolean;
                /** @enum {string} */
                state?: "OPEN" | "CLOSED" | "STOPPED" | "NOT_APPLICABLE";
                running?: boolean;
                /** Format: int64 */
                pollMillis?: number;
                /** Format: int64 */
                jitterMillis?: number;
                /** Format: int64 */
                polls?: number;
                /** Format: int64 */
                syncSuccesses?: number;
                /** Format: int64 */
                syncFailures?: number;
                /** Format: int64 */
                applies?: number;
                desired?: {
                    releaseId?: string | null;
                    /** Format: int64 */
                    generation?: number | null;
                    projectionFingerprint?: string | null;
                    scopeDigest?: string | null;
                    /** Format: date-time */
                    validUntil?: string | null;
                };
                negotiatedSchemaVersion?: number | null;
                /** @enum {string} */
                revocationChannel?: "CONSUMER_V2" | "RELEASE_WITHDRAWAL_ONLY" | "NONE";
                /** Format: date-time */
                lastSuccessAt?: string | null;
                /** Format: date-time */
                lastAttemptAt?: string | null;
                /** Format: int64 */
                lastSuccessMonotonicMillis?: number | null;
                /** Format: int64 */
                freshnessMillis?: number;
                /** Format: int64 */
                freshnessRemainingMillis?: number | null;
                consumerDeauthorized?: boolean;
                authorizationExpired?: boolean;
                /** Format: date-time */
                authorizationExpiresAt?: string | null;
                trackedReleases?: number;
                lastError?: {
                    code?: string | null;
                    kind?: string | null;
                    detail?: string | null;
                    /** Format: date-time */
                    at?: string | null;
                };
                report?: {
                    /** @enum {string} */
                    status?: "APPLIED" | "REPORT_PENDING" | "NONE";
                    /** Format: int64 */
                    pendingAttempts?: number;
                };
                credentialEnvRequiresRestart?: boolean;
            };
        };
        AgentProfileSummary: {
            id: string;
            name: string;
            description: string;
            revision: string;
            /** @enum {string} */
            readonlyResearchDefault: "AUTO" | "OFF";
            modelSettings?: components["schemas"]["SessionModelSettings"];
        };
        AgentProfileLoadError: {
            fileName: string;
            code: string;
            message: string;
        };
        AgentProfilesResponse: {
            profiles: components["schemas"]["AgentProfileSummary"][];
            loadErrors: components["schemas"]["AgentProfileLoadError"][];
        };
        /**
         * @description WU01 (uplift design §5): Hub association registration. The body
         *     never carries credential material — credentialRef is a slot name
         *     in the host store. baseUrl is fixed at registration.
         */
        HubConnectionRequest: {
            displayName: string;
            baseUrl: string;
            /** @description Credential slot name; never the value. */
            credentialRef?: string | null;
            /**
             * @default USER
             * @enum {string}
             */
            scope: "USER" | "PROJECT";
            /** @description Required when scope is PROJECT. */
            projectId?: string | null;
            /** @default true */
            enabled: boolean;
            /**
             * @description Explicit dev escape — plain HTTP on loopback only.
             * @default false
             */
            allowInsecureLoopback: boolean;
        };
        /**
         * @description Association update under CAS. baseUrl is intentionally absent —
         *     a Hub is never re-pointed in place.
         */
        HubConnectionUpdateRequest: {
            displayName?: string | null;
            credentialRef?: string | null;
            allowInsecureLoopback?: boolean | null;
            enabled?: boolean | null;
            /** Format: int64 */
            expectedRevision: number;
        };
        HubConnectionActionRequest: {
            /** @enum {string} */
            action: "CONNECT" | "TEST" | "DISCONNECT" | "DIAGNOSE";
        };
        /**
         * @description Public-safe Hub connection view (WU01). credentialConfigured is a
         *     presence flag for the slot; token material never crosses the wire.
         *     observed identity fields come from the Hub's own /api/v1/info.
         */
        HubConnectionResponse: {
            hubConnectionId?: string | null;
            displayName?: string | null;
            baseUrl?: string | null;
            /** @enum {string|null} */
            scope?: "USER" | "PROJECT" | null;
            projectId?: string | null;
            enabled?: boolean | null;
            /** Format: int64 */
            revision?: number | null;
            /** @enum {string|null} */
            connectionState?: "STOPPED" | "CONNECTING" | "READY" | "FAILED" | "DISABLED" | null;
            stateReason?: string | null;
            credentialConfigured?: boolean | null;
            insecureLoopback?: boolean | null;
            hubVersion?: string | null;
            apiVersion?: string | null;
            platform?: string | null;
            providerKinds?: string[] | null;
            /** Format: int64 */
            catalogRevision?: number | null;
            lastDiagnosis?: string | null;
            managedServerId?: string | null;
            /** Format: int64 */
            createdAt?: number | null;
            /** Format: int64 */
            updatedAt?: number | null;
        };
        WorkerSessionBinding: {
            /** @enum {string} */
            schemaVersion: "worker-session-binding/1";
            workerId: string;
            workerTaskId: string;
            attemptId: string;
            attemptEpoch: string;
            workspaceId: string;
            workspaceGeneration: string;
            /** @enum {string} */
            provider: "agentcode";
        };
        SessionFoundationResponse: {
            /** @enum {string} */
            schemaVersion: "session-foundation/1";
            hostId: string;
            storeId: string;
            sessionId: string;
            sessionVersion?: string;
            activeRunId?: string | null;
            runState?: string | null;
            runStateVersion?: string | null;
            runReasonCode?: string | null;
            journalEpoch: string;
            /** @enum {string} */
            executionOwnership: "HOST_SESSION" | "WORKER_ATTEMPT";
            executionBinding?: components["schemas"]["WorkerSessionBinding"];
            firstClientMessageId?: string | null;
            firstRunId?: string | null;
            /** @enum {boolean} */
            deadlineKnown: false;
            capabilities: {
                [key: string]: string;
            };
        };
        ObservationSnapshotRequest: {
            /**
             * @default session-observation-snapshot-request/1
             * @enum {string}
             */
            schemaVersion: "session-observation-snapshot-request/1";
            /**
             * @default PROGRESS
             * @enum {string}
             */
            profile: "PROGRESS";
            /** @default 30 */
            messageLimit: number;
            /** @default 100 */
            activityLimit: number;
            /** @default true */
            allowPartial: boolean;
        };
        ObservationSnapshotManifest: {
            /** @enum {string} */
            schemaVersion?: "session-observation-snapshot/1";
            snapshotId?: string;
            hostId?: string;
            storeId?: string;
            sessionId?: string;
            capturedFrom?: string;
            capturedTo?: string;
            /** @enum {string} */
            consistency?: "STABLE_COMPONENTS" | "COMPONENT_VECTOR";
            sourceVersions?: {
                [key: string]: string;
            };
            eventWindow?: {
                [key: string]: unknown;
            };
            coverage?: {
                [key: string]: unknown;
            };
            executionBinding?: components["schemas"]["WorkerSessionBinding"];
            /** @enum {boolean} */
            resumable?: false;
            itemsSha256?: string;
            /** Format: int64 */
            bytes?: number;
            /** Format: int64 */
            expiresAtMillis?: number;
        };
        ObservationSnapshotItem: {
            kind?: string;
            sourceRef?: string;
            sourceVersion?: string | null;
            capturedAt?: string;
            contentDigest?: string;
            missingReason?: string | null;
            content?: unknown;
        };
        ObservationSnapshotItemPage: {
            snapshotId?: string;
            nextCursor?: string | null;
            items?: components["schemas"]["ObservationSnapshotItem"][];
        };
        WritableCollaborationBudget: {
            /** @default 0 */
            logicalCalls: string;
            /** @default 0 */
            httpRequests: string;
            /** @default 0 */
            editAttempts: string;
        };
        WritableGraphUnit: {
            unitId: string;
            /** @enum {string} */
            kind: "READ_ONLY" | "WRITE_CANDIDATE";
            objective: string;
            /** @default default */
            agentProfileId: string;
            modelAlias?: string;
            readScope: string[];
            writeScope?: string[];
            dependsOn?: string[];
            /** @default true */
            required: boolean;
            /** @default false */
            allowNoChanges: boolean;
        };
        WritableCollaborationGraph: {
            /**
             * @default collaboration-graph/1
             * @enum {string}
             */
            schemaVersion: "collaboration-graph/1";
            /**
             * @default REJECT
             * @enum {string}
             */
            samePathMode: "REJECT" | "DEPENDENCY_CHAIN";
            /** @default 2 */
            requestedParallelism: number;
            units: components["schemas"]["WritableGraphUnit"][];
        };
        WriteGroupCreateRequest: {
            /**
             * @default collaboration-group-create/1
             * @enum {string}
             */
            schemaVersion: "collaboration-group-create/1";
            requestId: string;
            expectedExecutionEpoch: string;
            graph: components["schemas"]["WritableCollaborationGraph"];
        };
        WritableUnitBudget: {
            unitId: string;
            total: components["schemas"]["WritableCollaborationBudget"];
            perAttempt: components["schemas"]["WritableCollaborationBudget"];
        };
        WriteGroupAuthorizeRequest: {
            /**
             * @default collaboration-group-authorization/1
             * @enum {string}
             */
            schemaVersion: "collaboration-group-authorization/1";
            requestId: string;
            expectedGraphRevision: string;
            expectedExecutionEpoch?: string;
            graphFingerprint: string;
            /**
             * @default USER_CONFIRM
             * @enum {string}
             */
            adoptionMode: "USER_CONFIRM" | "PARENT_WITHIN_GRANT";
            /** @default 1 */
            retryLimit: number;
            /** @default 0 */
            repairLimit: number;
            integrationReserve: components["schemas"]["WritableCollaborationBudget"];
            repairReserve?: components["schemas"]["WritableCollaborationBudget"];
            units: components["schemas"]["WritableUnitBudget"][];
        };
        WriteGroupStartRequest: {
            /**
             * @default collaboration-group-start/1
             * @enum {string}
             */
            schemaVersion: "collaboration-group-start/1";
            startId: string;
            expectedGraphRevision: string;
            grantFingerprint: string;
            expectedExecutionEpoch: string;
        };
        WritableSelectedUnit: {
            unitId: string;
            candidateId: string;
            candidateFingerprint: string;
        };
        WriteSelectionRequest: {
            /**
             * @default collaboration-selection/1
             * @enum {string}
             */
            schemaVersion: "collaboration-selection/1";
            selectionId: string;
            expectedGraphRevision: string;
            /**
             * @default REQUIRE_CLOSURE
             * @enum {string}
             */
            dependencyPolicy: "REQUIRE_CLOSURE";
            units: components["schemas"]["WritableSelectedUnit"][];
        };
        WritePreviewRequest: {
            /**
             * @default collaboration-preview-request/1
             * @enum {string}
             */
            schemaVersion: "collaboration-preview-request/1";
            previewId: string;
            selectionId?: string;
            selectionFingerprint: string;
            /**
             * @default STRICT
             * @enum {string}
             */
            mode: "STRICT" | "THREE_WAY";
        };
        WritableResolution: {
            path: string;
            /**
             * @default MANUAL
             * @enum {string}
             */
            choice: "KEEP_CURRENT" | "TAKE_PROPOSED" | "MANUAL";
            text?: string;
        };
        WritePreviewRevisionRequest: {
            /**
             * @default collaboration-preview-revision/1
             * @enum {string}
             */
            schemaVersion: "collaboration-preview-revision/1";
            revisionId: string;
            previewFingerprint: string;
            /**
             * @default MANUAL
             * @enum {string}
             */
            strategy: "MANUAL" | "MODEL_PROPOSAL";
            reason: string;
            reviewId?: string;
            resolutions?: components["schemas"]["WritableResolution"][];
        };
        WriteAdoptionRequest: {
            /**
             * @default collaboration-adoption/1
             * @enum {string}
             */
            schemaVersion: "collaboration-adoption/1";
            adoptionId: string;
            expectedRunStateVersion: string;
            expectedExecutionEpoch: string;
            selectionId: string;
            selectionFingerprint: string;
            previewId: string;
            previewFingerprint: string;
            /**
             * @default STRICT
             * @enum {string}
             */
            mode: "STRICT" | "THREE_WAY";
            reviewId?: string;
            /** @enum {string} */
            revalidationDecision?: "GOAL_REVALIDATED";
        };
        WriteActionRequest: {
            /**
             * @default collaboration-action/1
             * @enum {string}
             */
            schemaVersion: "collaboration-action/1";
            requestId: string;
            expectedRevision?: string;
            reason?: string;
        };
        WriteReviewRequest: {
            /**
             * @default collaboration-review/1
             * @enum {string}
             */
            schemaVersion: "collaboration-review/1";
            reviewId: string;
            previewFingerprint: string;
            modelAlias?: string;
            question: string;
            /**
             * @default PARENT_REMAINING
             * @enum {string}
             */
            budgetSource: "PARENT_REMAINING";
            /**
             * @default REVIEW
             * @enum {string}
             */
            purpose: "REVIEW" | "REVISION_PROPOSAL";
            budget: components["schemas"]["WritableCollaborationBudget"];
        };
        WriteRepairRequest: {
            /**
             * @default collaboration-repair-request/1
             * @enum {string}
             */
            schemaVersion: "collaboration-repair-request/1";
            repairId: string;
            expectedAdoptionRevision: string;
            expectedRunStateVersion: string;
            expectedExecutionEpoch: string;
            objective: string;
        };
        WritableCollaborationRecord: {
            continuationCheckpointHash?: string | null;
            continuationCheckpointRef?: string | null;
            sourceEpoch?: string;
            remediatedBy?: string;
            reworkOf?: string;
            reworkId?: string;
            satisfiesUnits?: string[];
            parentControl?: string;
            cancelRequested?: boolean;
            createdAtEpochMillis?: string;
            adoptionMode?: string;
            retryLimit?: number;
            repairLimit?: number;
            /** @enum {string} */
            schemaVersion: "writable-collaboration-record/1";
            entityId: string;
            groupId: string;
            /** @enum {string} */
            kind: "GROUP" | "GRANT" | "CHILD" | "CANDIDATE" | "SELECTION" | "PREVIEW" | "ADOPTION" | "REVIEW" | "REPAIR";
            revision: string;
            state: string;
            graph?: components["schemas"]["WritableCollaborationGraph"];
            graphFingerprint?: string | null;
            grantFingerprint?: string | null;
            candidateFingerprint?: string | null;
            selectionFingerprint?: string | null;
            previewFingerprint?: string | null;
            targetFingerprint?: string | null;
            integrationCandidateFingerprint?: string | null;
            sourceReviewFingerprint?: string | null;
            parentTaskFingerprint?: string | null;
            modelBindingFingerprint?: string | null;
            reportFingerprint?: string | null;
            proposalFingerprint?: string | null;
            postCheckpointHash?: string | null;
            preCheckpointHash?: string | null;
            workspaceFingerprint?: string | null;
            sessionId?: string | null;
            executionEpoch?: string | null;
            actor?: string | null;
            unitId?: string | null;
            attempt?: string | null;
            dispatchId?: string | null;
            productRunId?: string | null;
            productJobId?: string | null;
            candidateId?: string | null;
            childAttemptId?: string | null;
            grantId?: string | null;
            selectionId?: string | null;
            previewId?: string | null;
            adoptionId?: string | null;
            reviewId?: string | null;
            mode?: string | null;
            productKind?: string | null;
            productState?: string | null;
            reasonCode?: string | null;
            effectState?: string | null;
            verificationRef?: string | null;
            verificationLevel?: string | null;
            postCheckpointRef?: string | null;
            revisionOrigin?: string | null;
            expiresAt?: string | null;
            answer?: string | null;
            budgetSource?: string | null;
            purpose?: string | null;
            quiescent?: boolean;
            requiresRevalidation?: boolean;
            contentApplied?: boolean;
            verificationPassed?: boolean;
            contextCommitted?: boolean;
            start?: boolean;
            readScope?: string[];
            writeScope?: string[];
            conflicts?: string[];
            appliedPaths?: string[];
            candidateIds?: string[];
            selectedUnits?: string[];
            currentVersions?: {
                [key: string]: string;
            };
            children?: components["schemas"]["WritableCollaborationRecord"][];
            selections?: components["schemas"]["WritableCollaborationRecord"][];
            previews?: components["schemas"]["WritableCollaborationRecord"][];
            adoptions?: components["schemas"]["WritableCollaborationRecord"][];
            repairs?: components["schemas"]["WritableCollaborationRecord"][];
            sourceAdoptionId?: string;
            repairId?: string;
            remediatesAdoptionId?: string;
            reviews?: components["schemas"]["WritableCollaborationRecord"][];
            candidates?: components["schemas"]["WritableCollaborationRecord"][] | {
                [key: string]: string;
            };
            manifest?: {
                [key: string]: unknown;
            };
            sources?: {
                [key: string]: unknown;
            };
            budgets?: {
                [key: string]: unknown;
            };
            report?: {
                [key: string]: unknown;
            };
            proposal?: {
                [key: string]: unknown;
            };
            sharedBudget?: {
                [key: string]: {
                    [key: string]: string;
                };
            };
            agentProfileId?: string | null;
            profileRevision?: string | null;
            modelPin?: string | null;
            objectiveMessageId?: string;
            resultMessageId?: string;
            resultHistoryTruncated?: boolean;
            childBudget?: {
                [key: string]: {
                    [key: string]: string;
                };
            };
            authorization?: components["schemas"]["WritableCollaborationRecord"];
        } & {
            [key: string]: unknown;
        };
        WritableCollaborationPage: {
            items: components["schemas"]["WritableCollaborationRecord"][];
        };
        CollaborationAttemptActivity: {
            /** @description Actual durable producers are stopped; retained partial effects may still make quiescent false. Only meaningful with FULL_ATTEMPT coverage, exact producer identity and closed original intake. */
            producerQuiescent: boolean;
            /** @enum {string} */
            coverage: "FULL_ATTEMPT" | "LEGACY_PARENT";
            producerIdentityUnproven: boolean;
            producerEvidenceDigest: string;
            /** @enum {string} */
            schemaVersion: "collaboration-attempt-activity/1";
            runId: string;
            sessionId: string;
            executionEpoch: string;
            observedAtEpochMillis: string;
            activeWriters: string;
            activeModels: string;
            pendingAdoptions: string;
            quiescent: boolean;
            retentionRequired: boolean;
            evidenceReady: boolean;
            evidenceId?: string | null;
            evidenceDigest?: string | null;
        };
        WritableCandidateFile: {
            path?: string;
            offset?: string;
            length?: string;
            /** @enum {string} */
            encoding?: "BASE64";
            content?: string;
            nextOffset?: string | null;
            candidateFingerprint?: string;
            items?: ({
                path?: string;
                /** @enum {string} */
                effect?: "CREATE" | "UPDATE" | "DELETE";
                baseVersion?: string;
                contentBlobRef?: string | null;
            } & {
                [key: string]: unknown;
            })[];
        } & {
            [key: string]: unknown;
        };
        WritablePreviewFile: {
            /** @enum {string} */
            schemaVersion: "collaboration-preview-files/1";
            previewId: string;
            previewFingerprint: string;
            /** @enum {string} */
            side: "BASE" | "CURRENT" | "PROPOSED" | "INTEGRATION";
            path?: string;
            exists?: boolean;
            offset?: string;
            length?: string;
            /** @enum {string} */
            encoding?: "BASE64";
            content?: string;
            nextOffset?: string | null;
            items?: {
                path?: string;
                version?: string;
            }[];
        };
    };
    responses: {
        /** @description Stable problem document */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Bearer token is required */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        IdempotencyKey: string;
        ClientSessionId: string;
        ClientSessionToken: string;
        ProjectId: string;
        RunId: string;
        SessionId: string;
        BusinessSessionId: string;
        TerminalSessionId: string;
        ServerId: string;
        SkillId: string;
        SkillVersionDigest: string;
        McpOperationId: string;
        ExecutionId: string;
        SpecId: string;
        MissionId: string;
        MessageId: string;
        AttachmentId: string;
        WorkspaceLaneId: string;
        DeliveryId: string;
        GitOperationId: string;
        GitCommitId: string;
        PublicationId: string;
        /** @description CAS version precondition, for example "sha256:<digest>:<size>" */
        IfMatch: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listClientSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Active sessions without secrets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ClientSessionSummaryResponse"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    registerClientSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClientRegistrationRequest"];
            };
        };
        responses: {
            /** @description Registered client session; response is no-store */
            201: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClientSessionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            429: components["responses"]["Problem"];
        };
    };
    heartbeatClientSession: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                clientSessionId: components["parameters"]["ClientSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Heartbeat result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClientHeartbeatResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    revokeClientSession: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                clientSessionId: components["parameters"]["ClientSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked or already revoked */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            410: components["responses"]["Problem"];
        };
    };
    getOperationReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                receiptId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationReceiptResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    lookupOperationReceipt: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OperationLookupRequest"];
            };
        };
        responses: {
            /** @description Durable operation receipt */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationReceiptResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getEventSnapshot: {
        parameters: {
            query: {
                scopeType: "GLOBAL" | "SESSION" | "MISSION";
                scopeId?: string;
                pageSize?: number;
                snapshotToken?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fixed-high-water-mark event snapshot page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventSnapshotResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
        };
    };
    listSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sessions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionCreateRequest"];
            };
        };
        responses: {
            /** @description Created session */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    listSessionSummaries: {
        parameters: {
            query?: {
                workspaceAlias?: string;
                /** @description ACTIVE (default) | ARCHIVED | ALL */
                archived?: "ACTIVE" | "ARCHIVED" | "ALL";
                /** @description Inclusive title-substring filter; user %/_ are literals, max 128 code points */
                q?: string;
                limit?: number;
                /** @description Opaque signed continuation token from nextCursor */
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Summary page validated against one list read revision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionSummaryPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            /** @description HISTORY_REVISION_CHANGED */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description HISTORY_CURSOR_EXPIRED */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    patchSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionPatchRequest"];
            };
        };
        responses: {
            /** @description Patched session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description SESSION_VERSION_CONFLICT */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSessionFoundation: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen bounded observation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionFoundationResponse"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    createObservationSnapshot: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ObservationSnapshotRequest"];
            };
        };
        responses: {
            /** @description Frozen bounded observation */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObservationSnapshotManifest"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getObservationSnapshot: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
                snapshotId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen bounded observation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObservationSnapshotManifest"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    pageObservationSnapshotItems: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
                snapshotId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frozen bounded observation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ObservationSnapshotItemPage"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getSessionModelSettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session model settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionModelSettingsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    patchSessionModelSettings: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionModelSettingsPatchRequest"];
            };
        };
        responses: {
            /** @description Accepted settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionModelSettingsResponse"];
                };
            };
            /** @description Settings persisted and pending the next safe request boundary */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionModelSettingsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description Settings revision or catalog revision conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Invalid or unsupported model settings */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSessionSummary: {
        parameters: {
            query?: {
                /** @description "refresh" bypasses the fingerprint-keyed environment-probe cache and re-scans the workspace for the status-panel environment section (design 2026-09-26 §7.4). */
                probe?: "refresh";
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session summary without messages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionSummaryResponse"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    getSessionMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session metadata; message content lives on the paginated message endpoints */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionMetadataResponse"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    listSessionExecutions: {
        parameters: {
            query?: {
                runId?: string;
                kind?: "BUILD" | "VERIFICATION" | "PROCESS" | "SHELL" | "PTY" | "SANDBOX_EXEC";
                toolId?: string;
                limit?: number;
                /** @description Opaque continuation — the last executionId of the previous page */
                cursor?: string;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Execution record page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionExecutionPage"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    getSessionExecution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                executionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Verbatim execution record (execution/1 schema) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionExecutionRecord"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    readSessionExecutionArtifact: {
        parameters: {
            query?: {
                offset?: number;
                maxBytes?: number;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                executionId: string;
                /** @description Record-relative path, e.g. artifacts/cmd-001.stdout.log */
                artifactPath: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded artifact slice */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionExecutionArtifactSlice"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    pageSessionMessages: {
        parameters: {
            query?: {
                limit?: number;
                /** @description beforeCursor/afterCursor from a previous page; mutually exclusive with aroundMessageId */
                cursor?: string;
                /** @description Re-anchor near this message after a revision change; mutually exclusive with cursor */
                aroundMessageId?: string;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Message page; oversized bodies arrive as DEFERRED previews */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionMessagePageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            /** @description HISTORY_REVISION_CHANGED */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description HISTORY_CURSOR_EXPIRED */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description HISTORY_ITEM_TOO_LARGE */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    sendSessionMessage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionMessageRequest"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionMessageResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getMessageContentPage: {
        parameters: {
            query?: {
                /** @description Opaque segment continuation token from nextCursor */
                cursor?: string;
                /** @description Whole-response UTF-8 byte ceiling */
                maxBytes?: number;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                messageId: components["parameters"]["MessageId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One content segment */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MessageContentPageResponse"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            /** @description HISTORY_REVISION_CHANGED */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description HISTORY_CURSOR_EXPIRED */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    getSessionAttachmentContent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                messageId: components["parameters"]["MessageId"];
                attachmentId: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Attachment text content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getSessionAttachmentBytes: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                messageId: components["parameters"]["MessageId"];
                attachmentId: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Raw image bytes */
            200: {
                headers: {
                    /** @description Exact byte length of the image payload */
                    "Content-Length"?: number;
                    /** @description Always "private, no-store" */
                    "Cache-Control"?: string;
                    /** @description Always "nosniff" */
                    "X-Content-Type-Options"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "image/png": string;
                    "image/jpeg": string;
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description INPUT_ASSET_MISSING (blob absent for an owned reference) */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description INPUT_ASSET_HASH_MISMATCH (stored bytes do not match the frozen hash) */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    forkSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionForkRequest"];
            };
        };
        responses: {
            /** @description Forked session */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    archiveSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionArchiveRequest"];
            };
        };
        responses: {
            /** @description Archived session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    listAttention: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Attention items */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["AttentionItem"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createSpec: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpecCreateRequest"];
            };
        };
        responses: {
            /** @description Created spec */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpecResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getSpec: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                specId: components["parameters"]["SpecId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Spec view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpecResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    reviseSpec: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                specId: components["parameters"]["SpecId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpecRevisionRequest"];
            };
        };
        responses: {
            /** @description Revised spec */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpecResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description SPEC_REVISION_CONFLICT (stale expectedRevision) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    decideSpecApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                specId: components["parameters"]["SpecId"];
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SpecApprovalDecisionRequest"];
            };
        };
        responses: {
            /** @description Decision recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpecApprovalResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description fingerprint mismatch or approval expiry */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    convertSpecToAct: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                specId: components["parameters"]["SpecId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: int64 */
                    expectedRevision: number;
                };
            };
        };
        responses: {
            /** @description Conversion result (taskId/fingerprint for the run) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SpecConversionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getCommandApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending command approval */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingCommandApproval"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description No pending command approval */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    decideCommandApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommandApprovalDecision"];
            };
        };
        responses: {
            /** @description Decision recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description stale fingerprint or approval expiry */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getBudgetApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending budget approval */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BudgetApprovalResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description No pending budget approval */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    decideBudgetApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BudgetApprovalServiceDecisionRequest"];
            };
        };
        responses: {
            /** @description Decision recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BudgetApprovalResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description stale requestFingerprint or approval expiry */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    cancelRun: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    fingerprint?: string | null;
                };
            };
        };
        responses: {
            /** @description Cancellation accepted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Capability document */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CapabilityResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getExecutionBackends: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cached backend state; this request never probes Docker */
            200: {
                headers: {
                    ETag?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionBackendStatusResponse"];
                };
            };
            /** @description The catalog fingerprint has not changed */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    refreshExecutionBackends: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Probe result snapshot */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionBackendStatusResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getSessionExecutionPolicy: {
        parameters: {
            query?: {
                /** @description Optional server context for compatibility clients; production sessions resolve this from session state. */
                projectId?: string;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Effective execution policy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    updateSessionExecutionPolicy: {
        parameters: {
            query?: {
                /** @description Optional server context for compatibility clients; production sessions resolve this from session state. */
                projectId?: string;
            };
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPolicyUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated execution policy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getSessionAutomationControl: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Automation queue control */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AutomationControlResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    controlSessionAutomation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AutomationControlRequest"];
            };
        };
        responses: {
            /** @description Updated automation queue control */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AutomationControlResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMyExecutionPolicyDefaults: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description User execution policy defaults */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    updateMyExecutionPolicyDefaults: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPolicyUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated user policy defaults */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getProjectExecutionPolicyDefaults: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project execution policy defaults */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    updateProjectExecutionPolicyDefaults: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPolicyUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated project policy defaults */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPolicyResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listSessionApprovals: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approval projection page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    getApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approval projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalRequestV2"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    decideApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApprovalDecisionRequest"];
            };
        };
        responses: {
            /** @description Decision projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalRequestV2"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    advanceApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApprovalAdvanceRequest"];
            };
        };
        responses: {
            /** @description Advanced approval projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalRequestV2"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    controlApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApprovalAdvanceRequest"];
            };
        };
        responses: {
            /** @description Controlled approval projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovalRequestV2"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listTerminalSessions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                businessSessionId: components["parameters"]["BusinessSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Terminal session projections */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalSessionResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createTerminalSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                businessSessionId: components["parameters"]["BusinessSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalSessionCreateRequest"];
            };
        };
        responses: {
            /** @description Terminal session accepted for start */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalSessionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getTerminalSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Terminal session snapshot */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalSessionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    closeTerminalSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalCloseRequest"];
            };
        };
        responses: {
            /** @description Close result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalCloseResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    acquireTerminalControl: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalControlAcquireRequest"];
            };
        };
        responses: {
            /** @description Acquired terminal control lease */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalControlResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    renewTerminalControl: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalControlRenewRequest"];
            };
        };
        responses: {
            /** @description Renewed terminal control lease */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalControlResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    releaseTerminalControl: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalControlReleaseRequest"];
            };
        };
        responses: {
            /** @description Released terminal control lease */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalControlResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getTerminalOutput: {
        parameters: {
            query?: {
                cursor?: string;
                maxBytes?: number;
                waitMillis?: number;
                mode?: components["schemas"]["TerminalOutputMode"];
            };
            header?: never;
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded output page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalOutputResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            410: components["responses"]["Problem"];
        };
    };
    streamTerminalOutput: {
        parameters: {
            query?: {
                cursor?: string;
                maxBytes?: number;
                waitMillis?: number;
            };
            header?: never;
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Terminal output event stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    writeTerminalInput: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalInputRequest"];
            };
        };
        responses: {
            /** @description Input delivery result */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalInputResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    resizeTerminalSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalResizeRequest"];
            };
        };
        responses: {
            /** @description Applied terminal size */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalResizeResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    signalTerminalSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                terminalSessionId: components["parameters"]["TerminalSessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TerminalSignalRequest"];
            };
        };
        responses: {
            /** @description Signal delivery result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TerminalSignalResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    listProjects: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectSummary"][];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    registerProject: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectRegistrationRequest"];
            };
        };
        responses: {
            /** @description Registration result (canonicalRoot is only for the caller) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectRegistrationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectSummary"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getProjectStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getProjectSessionPreflight: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session creation preflight */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectSessionPreflight"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getProjectBuildPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resolved build plan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectBuildPlanResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    putProjectBuildPlanOverride: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BuildPlanOverrideRequest"];
            };
        };
        responses: {
            /** @description Persisted override plus the re-resolved target view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BuildPlanOverrideResponse"];
                };
            };
            /** @description INVALID_REQUEST — element-level validation failure */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description TARGET_NOT_FOUND or PROJECT_NOT_FOUND */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    previewProjectBuildPlan: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BuildPlanOverrideRequest"];
            };
        };
        responses: {
            /** @description Candidate override plus the resolved target view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BuildPlanPreviewResponse"];
                };
            };
            /** @description INVALID_REQUEST — element-level validation failure */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description TARGET_NOT_FOUND or PROJECT_NOT_FOUND */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listVerificationProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Persisted verification profiles */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerificationProfileListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description FEATURE_DISABLED — profile service not enabled */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getVerificationProfile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
                profileId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The persisted profile */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerificationProfileResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description NOT_FOUND — no such profile */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    putVerificationProfile: {
        parameters: {
            query?: never;
            header: {
                /** @description Expected stored revision for the update. */
                "If-Match"?: string;
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
                profileId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerificationProfileRequest"];
            };
        };
        responses: {
            /** @description The persisted profile with its new revision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerificationProfileResponse"];
                };
            };
            /** @description INVALID_REQUEST — malformed profileId or config */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description REVISION_CONFLICT — the stored revision moved */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    readProjectFile: {
        parameters: {
            query?: {
                /** @description Current workspace snapshot fingerprint, or current. */
                revision?: string;
            };
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
                /** @description Workspace-relative file reference; path traversal and symlinks are rejected. */
                fileRef: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded file projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileReadResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    createNativeOpenIntent: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action?: "REVEAL" | "IDE" | "USER_TERMINAL" | "REVEAL_FILE";
                    /**
                     * @description Server-owned file reference (validated against the run's
                     *     changedFiles); required for REVEAL_FILE, rejected otherwise.
                     */
                    fileRef?: string | null;
                };
            };
        };
        responses: {
            /** @description Signed intent (returned only to the authenticated main) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NativeOpenIntent"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    listRuns: {
        parameters: {
            query?: {
                sessionId?: string;
                workspaceAlias?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paged run list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getSchedulerOverview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Scheduler overview */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SchedulerOverviewResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStateResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getRunScheduling: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run scheduling state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunSchedulingResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    listRunCommands: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Command ID from nextBefore in this Run */
                before?: string;
            };
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Retained command receipts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCommandPage"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    submitRunCommand: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunCommandRequest"];
            };
        };
        responses: {
            /** @description Terminal receipt or idempotent terminal replay */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCommandReceipt"];
                };
            };
            /** @description Accepted intent, including an unresolved UNKNOWN dispatch */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCommandReceipt"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getRunCommand: {
        parameters: {
            query?: never;
            header: {
                "X-CodeAgent-Client-Token": components["parameters"]["ClientSessionToken"];
            };
            path: {
                runId: components["parameters"]["RunId"];
                commandId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current persistent receipt for this command */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCommandReceipt"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    controlRun: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunControlRequest"];
            };
        };
        responses: {
            /** @description Request accepted or replayed; inspect Run controlState */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStateResponse"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getLatestRunControl: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
                controlId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run view when controlId is the latest command */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStateResponse"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    interruptRun: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RunInterruptRequest"];
            };
        };
        responses: {
            /** @description Interrupt accepted (or idempotent replay) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStateResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description STATE_VERSION_CONFLICT or run not interruptable */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    continueRun: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["RunContinueRequest"];
            };
        };
        responses: {
            /** @description Continuation run created (or idempotent replay of it) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunStateResponse"];
                };
            };
            /** @description RUN_ATTENTION_NOT_CLEARED or invalid body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description STATE_VERSION_CONFLICT or RUN_NOT_CONTINUABLE */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getRunEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Evidence bundle */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceBundleResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    listWorkspaceExecutions: {
        parameters: {
            query: {
                projectId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Workspace execution list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createWorkspaceExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceExecutionCreateRequest"];
            };
        };
        responses: {
            /** @description Workspace execution provisioned */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getWorkspaceExecution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceExecutionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Workspace execution */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    renewWorkspaceExecutionLease: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceExecutionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceExecutionLeaseRenewRequest"];
            };
        };
        responses: {
            /** @description Lease renewed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    handoffWorkspaceExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceExecutionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceExecutionHandoffRequest"];
            };
        };
        responses: {
            /** @description Handoff state updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    reclaimWorkspaceExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceExecutionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceExecutionReclaimRequest"];
            };
        };
        responses: {
            /** @description Workspace execution reclaimed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceExecutionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    createWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLaneCreateRequest"];
            };
        };
        responses: {
            /** @description Workspace lane projection */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getWorkspaceLane: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Workspace lane projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    bindWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLaneBindRequest"];
            };
        };
        responses: {
            /** @description Bound lane projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    reopenWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLaneReopenRequest"];
            };
        };
        responses: {
            /** @description Reopened lane projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    releaseWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLaneReleaseRequest"];
            };
        };
        responses: {
            /** @description Released or retained lane projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    createRemoteWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RemoteWorkspaceLaneCreateRequest"];
            };
        };
        responses: {
            /** @description Accepted lane creation; follow the operation for materialization progress */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RemoteWorkspaceLaneCreateResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    resumeWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Async placement operation */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    suspendWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Async suspend operation */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    syncWorkspaceLane: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLaneSyncRequest"];
            };
        };
        responses: {
            /** @description Async sync operation */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getWorkspaceLaneTree: {
        parameters: {
            query?: {
                cursor?: string;
                prefix?: string;
            };
            header?: never;
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded tree page; truncated entries require cursor continuation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneTreeResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    readWorkspaceLaneFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
                /** @description Lane-relative safe file reference; path traversal and symlinks are rejected. */
                fileRef: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded file projection carrying the CAS digest */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneFileResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    writeWorkspaceLaneFile: {
        parameters: {
            query?: never;
            header: {
                /** @description CAS version precondition, for example "sha256:<digest>:<size>" */
                "If-Match": components["parameters"]["IfMatch"];
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
                /** @description Lane-relative safe file reference; path traversal and symlinks are rejected. */
                fileRef: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "text/plain": string;
            };
        };
        responses: {
            /** @description Written file version */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLaneFileResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
        };
    };
    getWorkspaceLaneGitStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Safe Git status projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitLaneStatusResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    createWorkspaceChangeSet: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangeSetCreateRequest"];
            };
        };
        responses: {
            /** @description Frozen ChangeSet projection */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChangeSetResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
        };
    };
    createGitCommit: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                workspaceLaneId: components["parameters"]["WorkspaceLaneId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitCommitCreateRequest"];
            };
        };
        responses: {
            /** @description Async commit operation; commit success implies nothing about push or PR */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
        };
    };
    createRemotePublication: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                commitId: components["parameters"]["GitCommitId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RemotePublicationCreateRequest"];
            };
        };
        responses: {
            /** @description Async push operation */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    createPullRequest: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                publicationId: components["parameters"]["PublicationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PullRequestCreateRequest"];
            };
        };
        responses: {
            /** @description Async pull-request operation */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getGitOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["GitOperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Git operation projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    reconcileGitOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                operationId: components["parameters"]["GitOperationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitOperationReconcileRequest"];
            };
        };
        responses: {
            /** @description Reconciliation operation state */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    cancelGitOperation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                operationId: components["parameters"]["GitOperationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GitOperationCancelRequest"];
            };
        };
        responses: {
            /** @description Operation state after the cancel request */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GitOperationResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    createDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryCreateRequest"];
            };
        };
        responses: {
            /** @description Delivery candidate */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delivery projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getDeliveryChanges: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-generated delivery file diff */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryChangesResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    prepareDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryPrepareRequest"];
            };
        };
        responses: {
            /** @description Prepared delivery projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    decideDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryDecisionRequest"];
            };
        };
        responses: {
            /** @description Decision projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    applyDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryApplyRequest"];
            };
        };
        responses: {
            /** @description Delivery accepted for integration */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    reconcileDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryReconcileRequest"];
            };
        };
        responses: {
            /** @description Reconciled delivery projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    rebaseDelivery: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                deliveryId: components["parameters"]["DeliveryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryRebaseRequest"];
            };
        };
        responses: {
            /** @description Rebase accepted; the delivery is REBASING until the worker completes */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommandResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    listProjectDeliveries: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                projectId: components["parameters"]["ProjectId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delivery page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    listMissions: {
        parameters: {
            query?: {
                sessionId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mission list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    createMission: {
        parameters: {
            query: {
                sessionId: string;
            };
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionCreateRequest"];
            };
        };
        responses: {
            /** @description Mission created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMission: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mission detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    planMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionPlanRequest"];
            };
        };
        responses: {
            /** @description Plan accepted, awaiting approval */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    decideMissionApproval: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
                approvalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionApprovalDecisionRequest"];
            };
        };
        responses: {
            /** @description Decision recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    startMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionCommandRequest"];
            };
        };
        responses: {
            /** @description Mission started */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    pauseMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionCommandRequest"];
            };
        };
        responses: {
            /** @description Pause requested */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    resumeMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionCommandRequest"];
            };
        };
        responses: {
            /** @description Mission resumed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    cancelMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionCommandRequest"];
            };
        };
        responses: {
            /** @description Cancellation requested */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    replanMission: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MissionPlanRequest"];
            };
        };
        responses: {
            /** @description Replan revision submitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMissionArtifacts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                missionId: components["parameters"]["MissionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mission artifacts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MissionArtifactsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listPolicyLayers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Policy layers with effective ceiling */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyLayersResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    updatePolicyLayer: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                layer: "PROJECT" | "USER";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PolicyLayerUpdateRequest"];
            };
        };
        responses: {
            /** @description Layer updated; revision bumped and policy.updated emitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyLayersResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    getEffectiveRiskPolicy: {
        parameters: {
            query?: {
                sessionId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Effective risk policy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getProductSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Product settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProductSettingsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    updateProductSettings: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProductSettingsUpdateRequest"];
            };
        };
        responses: {
            /** @description Settings updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProductSettingsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    listKnowledge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Knowledge items and confirmed facts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    suggestKnowledge: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: string;
                    sourceRef?: string | null;
                };
            };
        };
        responses: {
            /** @description Suggestion recorded as PENDING */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeItemResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    confirmKnowledge: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                knowledgeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Knowledge confirmed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KnowledgeItemResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getRunActivities: {
        parameters: {
            query?: {
                afterCursor?: number;
                limit?: number;
            };
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deterministic activity fold with honest completeness flags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunActivityListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getRunReasoning: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deterministic reasoning fold with honest completeness flags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunReasoningResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getRunOutput: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deterministic output fold with honest completeness flags */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunOutputResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getRunDiff: {
        parameters: {
            query?: {
                page?: number;
                pageSize?: number;
            };
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paged diff */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DiffPageResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            /** @description Legacy service does not expose the diff projection */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listRunWorkspaceConflicts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conflict list with current file versions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceConflictListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getWorkspaceConflict: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conflictId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conflict details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceConflictResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    resolveWorkspaceConflict: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conflictId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceConflictResolveRequest"];
            };
        };
        responses: {
            /** @description Conflict resolved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceConflictResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            /** @description Conflict state or file version changed */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listWorkspaceConflicts: {
        parameters: {
            query?: {
                projectId?: string;
                origin?: string;
                runId?: string;
                state?: string;
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Filtered conflicts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceConflictResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    autoMergeWorkspaceConflict: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conflictId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Auto-merge segment of the workspace-conflict/2 record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    requestWorkspaceConflictProposal: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conflictId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Proposal job accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description No merge-proposal producer is wired on this service */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getWorkspaceConflictProposal: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                proposalId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Proposal status {proposalId,status,proposalRef?,error?} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    dismissWorkspaceConflict: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                conflictId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conflict dismissed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceConflictResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    resolveWorkspaceConflictsBatch: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceConflictResolveBatchRequest"];
            };
        };
        responses: {
            /** @description Batch outcome {appliedPaths,pendingPaths,failedPaths,items} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
        };
    };
    putWorkspaceContent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/octet-stream": string;
            };
        };
        responses: {
            /** @description Stored content reference */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceContentsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            413: components["responses"]["Problem"];
        };
    };
    getWorkspaceContent: {
        parameters: {
            query?: {
                offset?: number;
                limit?: number;
            };
            header?: never;
            path: {
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Blob bytes; X-Content-Truncated marks partial reads */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    getRunReview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: components["parameters"]["RunId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Review projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReviewRunResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    createFixTask: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                findingId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    workspaceAlias: string;
                    goal: string;
                };
            };
        };
        responses: {
            /** @description Fix task created with finding lineage */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FixTaskResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getModelCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model catalog */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCatalogResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getModelCatalogAuthority: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Catalog authority status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelCatalogAuthorityResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    listAgentProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Specialist profiles and per-file load diagnostics */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentProfilesResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    fetchSource: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourceFetchRequest"];
            };
        };
        responses: {
            /** @description Fetched source with provenance and untrusted-content marker */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceFetchResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
            415: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMcpServers: {
        parameters: {
            query?: {
                scope?: "USER" | "PROJECT" | "OPERATOR" | null;
                projectId?: string;
                /**
                 * @description SUMMARY returns the legacy McpServerSummary projection; DETAIL
                 *     returns McpServerDetailResponse rows (extension design §9.1).
                 */
                view?: "SUMMARY" | "DETAIL";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description MCP server summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerSummary"][] | components["schemas"]["McpServerDetailResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    registerMcpServer: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpServerConfigRequest"];
            };
        };
        responses: {
            /** @description Registered server */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMcpResources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resource descriptors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpResourceDescriptor"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    readMcpResource: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpResourceReadRequest"];
            };
        };
        responses: {
            /** @description Resource content with provenance and untrusted marker */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpResourceReadResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
            415: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listSkills: {
        parameters: {
            query?: {
                view?: "FULL" | "SUMMARY";
                scope?: "PROJECT" | "USER" | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Skill records (FULL) or lightweight summaries (SUMMARY) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillRecordResponse"][] | components["schemas"]["SkillSummaryResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    registerSkill: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillRegisterRequest"];
            };
        };
        responses: {
            /** @description Registered skill */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillRecordResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    changeSkillStatus: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillStatusRequest"];
            };
        };
        responses: {
            /** @description Updated skill record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillRecordResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerDetailResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    updateMcpServer: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpServerUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated server */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description EXT_REVISION_CONFLICT */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    setMcpServerStatus: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpServerStatusRequest"];
            };
        };
        responses: {
            /** @description Updated server */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpServerDetailResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    requestMcpConnectionAction: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpConnectionActionRequest"];
            };
        };
        responses: {
            /** @description Operation accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getMcpOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                operationId: components["parameters"]["McpOperationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Operation state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMcpServerTools: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of tool descriptors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpToolListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    refreshMcpServerCatalog: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refresh accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpOperationResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listMcpResourceTemplates: {
        parameters: {
            query?: {
                cursor?: string | null;
            };
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resource template list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpResourceTemplateListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description MCP_PROFILE_UNSUPPORTED */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    listMcpPrompts: {
        parameters: {
            query?: {
                cursor?: string | null;
            };
            header?: never;
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Prompt list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpPromptListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            /** @description MCP_PROFILE_UNSUPPORTED */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    resolveMcpPrompt: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpPromptResolveRequest"];
            };
        };
        responses: {
            /** @description Expanded prompt content blocks */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpPromptResolveResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    requestMcpAuthAction: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                serverId: components["parameters"]["ServerId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["McpAuthActionRequest"];
            };
        };
        responses: {
            /** @description Auth action accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["McpAuthActionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getSkill: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Skill detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillDetailResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createSkillImportSource: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillImportSourceRequest"];
            };
        };
        responses: {
            /** @description Source handle */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillImportSourceResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            /** @description EXT_SCOPE_DENIED */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    previewSkillImport: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillImportPreviewRequest"];
            };
        };
        responses: {
            /** @description Import preview with diagnostics */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillImportPreviewResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            413: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    importSkillPackage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillImportRequest"];
            };
        };
        responses: {
            /** @description Imported skill detail */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillDetailResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            /** @description Preview source digest drifted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            413: components["responses"]["Problem"];
            /** @description SKILL_INVALID / SKILL_INCOMPATIBLE */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    listSkillVersions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillVersionListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getSkillVersionManifest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
                versionDigest: components["parameters"]["SkillVersionDigest"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version manifest */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillManifestResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    selectSkillVersion: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SkillVersionSelectRequest"];
            };
        };
        responses: {
            /** @description Updated skill detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillDetailResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    createExtensionTestExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionTestExecutionRequest"];
            };
        };
        responses: {
            /** @description Test execution created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionTestExecutionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getExecutionExtensions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                executionId: components["parameters"]["ExecutionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Extension binding evidence */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionExtensionsResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listExecutionExtensionInvocations: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                executionId: components["parameters"]["ExecutionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of invocation views */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionInvocationListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    runExtensionInvocationAction: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                executionId: components["parameters"]["ExecutionId"];
                invocationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionInvocationActionRequest"];
            };
        };
        responses: {
            /** @description The invocation view after the action settled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionInvocationView"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    listHooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hook summaries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HookSummary"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    listHookExecutions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Recent execution records */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HookExecutionListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    listHubConnections: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hub connection views */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"][];
                };
            };
            401: components["responses"]["Unauthorized"];
            503: components["responses"]["Problem"];
        };
    };
    registerHubConnection: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubConnectionRequest"];
            };
        };
        responses: {
            /** @description Registered connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            413: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getHubConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Connection view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
        };
    };
    updateHubConnection: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubConnectionUpdateRequest"];
            };
        };
        responses: {
            /** @description Updated connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    requestHubConnectionAction: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubConnectionActionRequest"];
            };
        };
        responses: {
            /** @description Connection view after the action */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    registerHubManagedServer: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Connection view carrying managedServerId */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubConnectionResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getHubCapabilities: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hub capability catalog payload (revision + capabilities) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    listHubResources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hub resource occupancy payload */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    listHubSessions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hub session list payload */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    acquireHubSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                hubConnectionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Acquired Hub session (Hub-owned schema) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    getHubSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                hubConnectionId: string;
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hub session view (Hub-owned schema) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    controlHubSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                hubConnectionId: string;
                sessionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Session after the action + cancelledRunning count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            502: components["responses"]["Problem"];
        };
    };
    createContextPackage: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContextPackageRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getContextPackage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: string;
                pid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getContextPackageItems: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                sid: string;
                pid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listAuxiliarySessions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    createAuxiliarySession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuxiliarySessionRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listAuxiliaryTurns: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                auxId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded scoped turn history */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    submitAuxiliaryTurn: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                auxId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuxiliaryTurnRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getAuxiliaryTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                auxId: string;
                tid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelAuxiliaryTurn: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                auxId: string;
                tid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listBoundaryInputs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    submitBoundaryInput: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BoundaryInputRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getBoundaryInput: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
                bid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelBoundaryInput: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                rid: string;
                bid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    preflightAssignmentTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssignmentTransitionRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listAssignmentTransitions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    submitAssignmentTransition: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssignmentTransitionRequest"];
            };
        };
        responses: {
            /** @description Durable scoped result */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getAssignmentTransition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
                hid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelAssignmentTransition: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                rid: string;
                hid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getExecutionSegments: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                rid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Durable scoped result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWorkerExecutionWindow: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Exact original Worker execution window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    publishWorkerExecutionWindow: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkerExecutionWindowRequest"];
            };
        };
        responses: {
            /** @description Exact original Worker execution window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listWritableCollaborationGroups: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationPage"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    createWritableCollaborationGroup: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteGroupCreateRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritableCollaborationGroup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    authorizeWritableCollaborationGroup: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteGroupAuthorizeRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    startWritableCollaborationGroup: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteGroupStartRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelWritableCollaborationGroup: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    selectWritableCandidates: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteSelectionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listWritableAdoptions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationPage"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    adoptWritablePreview: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteAdoptionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    listWritableExecutions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationPage"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritableExecution: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelWritableExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    reworkWritableExecution: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                executionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritableCandidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritableCandidateFiles: {
        parameters: {
            query?: {
                path?: string;
                offset?: string;
                limit?: string;
            };
            header?: never;
            path: {
                runId: string;
                groupId: string;
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCandidateFile"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    previewWritableSelection: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                selectionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WritePreviewRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    reviseWritablePreview: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                previewId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WritePreviewRevisionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    reviewWritablePreview: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                previewId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteReviewRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritablePreviewReview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
                reviewId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritableAdoption: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                groupId: string;
                adoptionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    cancelWritableAdoption: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                adoptionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    recoverWritableAdoption: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                adoptionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    startIsolatedWritableRepair: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                adoptionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteRepairRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getCollaborationAttemptActivity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Bounded collaboration projection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationAttemptActivity"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getWritablePreviewFiles: {
        parameters: {
            query?: {
                side?: "BASE" | "CURRENT" | "PROPOSED" | "INTEGRATION";
                unitId?: string;
                path?: string;
                offset?: string;
                limit?: string;
            };
            header?: never;
            path: {
                runId: string;
                groupId: string;
                previewId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fixed preview view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritablePreviewFile"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    closeWorkerExecutionWindow: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                sid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkerExecutionWindowRequest"];
            };
        };
        responses: {
            /** @description Exact original Worker execution window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    exportCollaborationFinalEvidence: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CollaborationEvidenceExportRequest"];
            };
        };
        responses: {
            /** @description Immutable evidence projection; private source paths are omitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    getCollaborationFinalEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                exportId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Immutable evidence projection; private source paths are omitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    readCollaborationFinalEvidenceBytes: {
        parameters: {
            query?: {
                offset?: string;
            };
            header?: never;
            path: {
                runId: string;
                exportId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Immutable evidence projection; private source paths are omitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    acknowledgeCollaborationEvidenceUpload: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                runId: string;
                exportId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CollaborationEvidenceUploadAck"];
            };
        };
        responses: {
            /** @description Immutable evidence projection; private source paths are omitted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollaborationResource"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
    recoverOriginalCollaborationRepair: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                runId: string;
                groupId: string;
                repairId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WriteActionRequest"];
            };
        };
        responses: {
            /** @description Bounded collaboration projection */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WritableCollaborationRecord"];
                };
            };
            default: components["responses"]["Problem"];
        };
    };
}
