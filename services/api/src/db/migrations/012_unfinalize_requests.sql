-- Запросы на откат финализации (контракт 0.19.0).
-- Отменить финализацию может только ADMIN или SUPERVISOR; инспектор оставляет запрос с причиной.
CREATE TABLE unfinalize_requests (
  id                 TEXT PRIMARY KEY,
  process_id         TEXT NOT NULL REFERENCES processes(id),
  object_id          TEXT NOT NULL,
  requested_by       TEXT,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'OPEN',  -- OPEN | DONE | REJECTED
  created_at         TEXT NOT NULL,
  resolved_by        TEXT,
  resolved_at        TEXT,
  resolution_comment TEXT
);
CREATE INDEX idx_unfinalize_requests_status ON unfinalize_requests(status, created_at);
CREATE INDEX idx_unfinalize_requests_process ON unfinalize_requests(process_id, status);
