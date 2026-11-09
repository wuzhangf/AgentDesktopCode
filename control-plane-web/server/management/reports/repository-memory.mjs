// In-memory ReportsRepository — DEV/TEST ONLY. Satisfies the repository seam
// so the module runs without management.db (unit tests, wiring bring-up).
// Production persistence is P5's sqlite adapter over ddl.sql; do NOT mount
// this in a real install — restart loses reports, which would violate the
// original-key recovery guarantee.
export function createMemoryReportsRepository() {
  const reports = new Map(); // reportId -> record
  const byKey = new Map();   // requestKey -> reportId
  const files = new Map();   // reportId -> [fileRecord]
  const prefs = new Map();   // ownerKey -> record
  const drafts = new Map();  // draftId -> record

  return {
    putReportRequest(rec) {
      reports.set(rec.reportId, { ...rec });
      byKey.set(rec.requestKey, rec.reportId);
    },
    findReportByRequestKey(requestKey) {
      const id = byKey.get(requestKey);
      return id ? { ...reports.get(id) } : null;
    },
    getReport(reportId) {
      const r = reports.get(reportId);
      return r ? { ...r } : null;
    },
    updateReport(reportId, patch) {
      const r = reports.get(reportId);
      if (r) reports.set(reportId, { ...r, ...patch });
    },
    listReports({ limit = 100, requestKey, state } = {}) {
      let rows = [...reports.values()];
      if (requestKey) rows = rows.filter((r) => r.requestKey === requestKey);
      if (state) rows = rows.filter((r) => r.state === state);
      rows.sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1) || a.reportId.localeCompare(b.reportId));
      return rows.slice(0, limit).map((r) => ({ ...r }));
    },
    putReportFile(rec) {
      const list = files.get(rec.reportId) ?? [];
      const i = list.findIndex((f) => f.fileId === rec.fileId);
      if (i >= 0) list[i] = { ...rec }; else list.push({ ...rec });
      files.set(rec.reportId, list);
    },
    listReportFiles(reportId) {
      return (files.get(reportId) ?? []).map((f) => ({ ...f }));
    },
    getReportPreferences(ownerKey) {
      const p = prefs.get(ownerKey);
      return p ? { ...p } : null;
    },
    putReportPreferences(ownerKey, record) {
      prefs.set(ownerKey, { ...record });
    },
    putSubscriptionDraft(draft) {
      drafts.set(draft.draftId, { ...draft });
    },
    listSubscriptionDrafts(ownerKey) {
      return [...drafts.values()].filter((d) => d.ownerKey === ownerKey).map((d) => ({ ...d }));
    },
  };
}
