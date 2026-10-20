-- «Продукт» — начальная схема (SQLite; типы и SQL держим переносимыми на PostgreSQL).
-- Смысл таблиц: docs/domain/data-model.md. id — UUID (TEXT), время — ISO 8601 (TEXT), JSON — TEXT.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('INSPECTOR','SUPERVISOR','ADMIN','ML_ENGINEER')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE objects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  address       TEXT,
  customer      TEXT,
  contractor    TEXT,
  permit_number TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------- матрица и нормативы
CREATE TABLE params (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL UNIQUE,
  section          TEXT NOT NULL,
  parameter_name   TEXT NOT NULL,
  unit             TEXT,
  source_pd        TEXT,
  source_rd        TEXT,
  source_id        TEXT,
  trigger_logic    TEXT,
  review_priority  TEXT NOT NULL,
  sp_reference     TEXT,
  gost_reference   TEXT,
  fz_reference     TEXT,
  other_normative  TEXT,
  data_type        TEXT NOT NULL,
  min_value        REAL,
  max_value        REAL,
  regex_pattern    TEXT,
  semantic_anchors TEXT NOT NULL DEFAULT '[]',
  enum_values      TEXT NOT NULL DEFAULT '[]',
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE matrix_versions (
  version         TEXT PRIMARY KEY,
  params_snapshot TEXT NOT NULL,
  params_count    INTEGER NOT NULL,
  comment         TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE logical_rules (
  id              TEXT PRIMARY KEY,
  rule_name       TEXT NOT NULL,
  condition       TEXT NOT NULL,
  expected        TEXT NOT NULL,
  normative_base  TEXT,
  review_priority TEXT NOT NULL DEFAULT 'MEDIUM',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE normative_base (
  id              TEXT PRIMARY KEY,
  document_name   TEXT NOT NULL,
  document_number TEXT NOT NULL,
  section         TEXT,
  parameter_name  TEXT,
  min_value       REAL,
  max_value       REAL,
  effective_from  TEXT,
  effective_to    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------- проверки и файлы
CREATE TABLE processes (
  id                  TEXT PRIMARY KEY,
  object_id           TEXT NOT NULL REFERENCES objects(id),
  status              TEXT NOT NULL,
  scenario            TEXT,
  upload_status       TEXT NOT NULL DEFAULT '[]',
  current_protocol_id TEXT,
  sync_status         TEXT NOT NULL DEFAULT 'NOT_SENT',
  progress            TEXT NOT NULL DEFAULT '{}',
  compare_mode        TEXT,            -- FULL | INCREMENTAL для ближайшего сравнения
  changed_file_ids    TEXT,            -- JSON: файлы для инкрементального сравнения
  compare_trigger     TEXT,            -- INITIAL | INCREMENTAL_UPLOAD | METADATA_CHANGE | MANUAL_RERUN
  error               TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finalized_at        TEXT,
  finalized_by        TEXT
);
CREATE INDEX idx_processes_object ON processes(object_id, created_at);

CREATE TABLE files (
  id                  TEXT PRIMARY KEY,
  object_id           TEXT NOT NULL REFERENCES objects(id),
  process_id          TEXT NOT NULL REFERENCES processes(id),
  original_name       TEXT NOT NULL,
  format              TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  file_hash           TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  pages_count         INTEGER,
  stage_hint          TEXT,
  doc_stage           TEXT,
  doc_kind            TEXT,
  discipline          TEXT,
  document_code       TEXT,
  revision            TEXT,
  approval_status     TEXT NOT NULL DEFAULT 'UNKNOWN',
  approval_date       TEXT,
  predecessor_id      TEXT,
  is_authoritative    INTEGER,
  metadata            TEXT,            -- JSON DocumentMetadata от ML
  metadata_confidence REAL,
  processing_status   TEXT NOT NULL,
  quality             TEXT NOT NULL DEFAULT '{}',
  parsed_ref          TEXT,            -- JSON S3Ref
  parser_version      TEXT,
  error               TEXT,
  uploaded_at         TEXT NOT NULL,
  UNIQUE (process_id, file_hash)
);
CREATE INDEX idx_files_process ON files(process_id);
CREATE INDEX idx_files_hash ON files(file_hash);

CREATE TABLE ml_jobs (
  message_id  TEXT PRIMARY KEY,
  process_id  TEXT NOT NULL REFERENCES processes(id),
  type        TEXT NOT NULL,           -- ml.parse.request | ml.compare.request
  file_id     TEXT,
  attempt     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL,           -- SENT | DONE | FAILED | SUPERSEDED
  envelope    TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_ml_jobs_process ON ml_jobs(process_id, status);

CREATE TABLE processed_messages (
  message_id   TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- протоколы и findings
CREATE TABLE protocols (
  id                  TEXT PRIMARY KEY,
  process_id          TEXT NOT NULL REFERENCES processes(id),
  object_id           TEXT NOT NULL REFERENCES objects(id),
  version             INTEGER NOT NULL,
  status              TEXT NOT NULL,   -- IN_PROGRESS | VERIFICATION_COMPLETED | PROTOCOL_FINALIZED
  is_current          INTEGER NOT NULL DEFAULT 1,
  trigger             TEXT NOT NULL,
  scenario            TEXT,
  upload_status       TEXT NOT NULL DEFAULT '[]',
  matrix_version      TEXT NOT NULL,
  dataset_version     TEXT NOT NULL,
  model_version       TEXT NOT NULL,
  parser_version      TEXT,
  input_manifest_hash TEXT NOT NULL,
  snapshot            TEXT NOT NULL,   -- неизменяемый снимок: реестр файлов, file_resolution, stats
  created_at          TEXT NOT NULL,
  finalized_at        TEXT,
  UNIQUE (process_id, version)
);

CREATE TABLE page_pairs (
  id                 TEXT PRIMARY KEY,
  protocol_id        TEXT NOT NULL REFERENCES protocols(id),
  pair_key           TEXT NOT NULL,
  left_file_id       TEXT NOT NULL,
  left_page          INTEGER NOT NULL,
  right_file_id      TEXT NOT NULL,
  right_page         INTEGER NOT NULL,
  match_score        REAL NOT NULL,
  homography         TEXT,
  compliance_percent REAL,
  diff_regions       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_page_pairs_protocol ON page_pairs(protocol_id);

CREATE TABLE evidence_groups (
  id         TEXT PRIMARY KEY,
  object_id  TEXT NOT NULL,
  param_code TEXT NOT NULL,
  rule_key   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_fragments (
  id                TEXT PRIMARY KEY,
  evidence_group_id TEXT NOT NULL REFERENCES evidence_groups(id),
  role              TEXT NOT NULL,     -- role_expected_actual: EXPECTED | ACTUAL | CONTEXT
  file_id           TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  stage             TEXT NOT NULL,
  document_code     TEXT,
  revision          TEXT,
  approval_status   TEXT,
  page              INTEGER NOT NULL,  -- sheet_page
  sheet             TEXT,
  bbox              TEXT NOT NULL,     -- bbox_polygon_norm
  polygon           TEXT,
  extracted_value   TEXT,
  normalized_value  TEXT,
  text_snippet      TEXT,
  source            TEXT,
  quality           TEXT,
  confidence        REAL
);
CREATE INDEX idx_fragments_group ON evidence_fragments(evidence_group_id);
CREATE INDEX idx_fragments_file_page ON evidence_fragments(file_id, page);

CREATE TABLE checks (
  id                   TEXT PRIMARY KEY,
  protocol_id          TEXT NOT NULL REFERENCES protocols(id),
  process_id           TEXT NOT NULL,
  object_id            TEXT NOT NULL,
  param_id             INTEGER,
  param_code           TEXT NOT NULL,
  finding_key          TEXT NOT NULL,
  rule_key             TEXT,
  finding_status       TEXT NOT NULL,  -- текущее (с учётом решения инспектора)
  model_finding_status TEXT NOT NULL,  -- исходное от модели
  completeness_status  TEXT NOT NULL,
  inspector_status     TEXT NOT NULL DEFAULT 'PENDING',
  stages_compared      TEXT NOT NULL DEFAULT '[]',
  missing_sources      TEXT NOT NULL DEFAULT '[]',
  expected_value       TEXT,
  actual_value         TEXT,
  delta                TEXT,
  unit                 TEXT,
  review_priority      TEXT NOT NULL,
  risk_level           TEXT,
  rationale            TEXT,
  rationale_source     TEXT,
  normative_reference  TEXT,
  confidence           REAL,
  approved_change_ref  TEXT,
  evidence_group_id    TEXT NOT NULL REFERENCES evidence_groups(id),
  page_pair_id         TEXT,
  parent_check_id      TEXT,
  is_split             INTEGER NOT NULL DEFAULT 0,
  evidence_changed     INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_checks_protocol ON checks(protocol_id, finding_status);
CREATE INDEX idx_checks_key ON checks(process_id, finding_key);

CREATE TABLE finding_decisions (
  id                  TEXT PRIMARY KEY,
  check_id            TEXT NOT NULL REFERENCES checks(id),
  action              TEXT NOT NULL,
  resulting_status    TEXT NOT NULL,
  reason_code         TEXT,
  comment             TEXT,
  approved_change_ref TEXT,
  user_id             TEXT NOT NULL,
  decided_at          TEXT NOT NULL,
  protocol_version    INTEGER NOT NULL
);
CREATE INDEX idx_decisions_check ON finding_decisions(check_id, decided_at);

CREATE TABLE suspicions (
  id                TEXT PRIMARY KEY,
  protocol_id       TEXT NOT NULL REFERENCES protocols(id),
  process_id        TEXT NOT NULL,
  object_id         TEXT NOT NULL,
  suspicion_key     TEXT NOT NULL,
  discovery_method  TEXT NOT NULL,
  confidence        REAL NOT NULL,
  description       TEXT NOT NULL,
  pd_reference      TEXT,
  rd_reference      TEXT,
  id_reference      TEXT,
  review_priority   TEXT NOT NULL,
  normative_base    TEXT,
  rule_id           TEXT,
  inspector_status  TEXT NOT NULL DEFAULT 'PENDING',
  evidence          TEXT NOT NULL DEFAULT '[]',
  page_pair_id      TEXT,
  promoted_check_id TEXT,
  comment           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_suspicions_protocol ON suspicions(protocol_id);

-- ---------------------------------------------------------------- обратная связь и ML
CREATE TABLE rejection_log (
  id                TEXT PRIMARY KEY,
  violation_id      TEXT NOT NULL,
  rejection_reason  TEXT NOT NULL,
  ai_verdict        TEXT,
  suggested_fix     TEXT,
  retraining_status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at        TEXT NOT NULL
);

CREATE TABLE dispute_log (
  id                TEXT PRIMARY KEY,
  violation_id      TEXT NOT NULL,
  inspector_comment TEXT,
  ai_comment        TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by       TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE dataset_items (
  id                TEXT PRIMARY KEY,
  evidence_group_id TEXT NOT NULL,
  check_id          TEXT NOT NULL,
  param_code        TEXT NOT NULL,
  gold_label        TEXT NOT NULL,     -- POSITIVE | NEGATIVE
  expert_id         TEXT NOT NULL,
  reason_code       TEXT,
  curation_status   TEXT NOT NULL DEFAULT 'DRAFT',
  curated_by        TEXT,
  curated_at        TEXT,
  dataset_version   TEXT,
  split             TEXT,
  object_group_id   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (check_id)
);

CREATE TABLE dataset_versions (
  version      TEXT PRIMARY KEY,
  items_count  INTEGER NOT NULL,
  positives    INTEGER NOT NULL,
  negatives    INTEGER NOT NULL,
  split_hashes TEXT NOT NULL DEFAULT '{}',
  comment      TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE model_versions (
  model_version          TEXT PRIMARY KEY,
  artifact_hash          TEXT,
  dataset_version        TEXT NOT NULL,
  matrix_version         TEXT,
  metrics_json           TEXT NOT NULL DEFAULT '{}',
  thresholds_passed      INTEGER NOT NULL DEFAULT 0,
  approval_status        TEXT NOT NULL DEFAULT 'PENDING',
  approved_by            TEXT,
  deployed_at            TEXT,
  rollback_to            TEXT,
  previous_model_version TEXT,
  training_params        TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL
);

CREATE TABLE ml_retraining_log (
  id                   TEXT PRIMARY KEY,
  model_version        TEXT NOT NULL,
  dataset_version      TEXT NOT NULL,
  split_hashes         TEXT,
  precision            REAL,
  recall               REAL,
  f1                   REAL,
  false_positive_rate  REAL,
  per_category_metrics TEXT,
  approval_status      TEXT,
  approved_by          TEXT,
  created_at           TEXT NOT NULL
);

-- ---------------------------------------------------------------- служебные
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  object_id   TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  timestamp   TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_audit_time ON audit_log(timestamp);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  role       TEXT,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  process_id TEXT,
  object_id  TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE integration_outbox (
  id              TEXT PRIMARY KEY,
  process_id      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  sync_status     TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE monitoring_metrics (
  id           TEXT PRIMARY KEY,
  metric_name  TEXT NOT NULL,
  value        REAL NOT NULL,
  timestamp    TEXT NOT NULL,
  service_name TEXT NOT NULL,
  tags         TEXT
);
