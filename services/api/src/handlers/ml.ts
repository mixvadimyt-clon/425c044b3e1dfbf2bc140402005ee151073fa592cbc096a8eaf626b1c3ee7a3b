import { type AppContext, type Handlers, requireRole } from '../context.js';
import { ApiError } from '../errors.js';
import { listDatasetVersions, exportDataset, releaseDataset } from '../modules/mlops/dataset.js';
import { MLFLOW_COOKIE, MLFLOW_ROLES, signSession } from '../modules/mlops/mlflow.js';
import { decideModel, listModels, registerModel } from '../modules/mlops/models.js';
import { weeklyReport } from '../modules/mlops/weekly.js';
import type { S } from '../types.js';

/** ML-контур (REQ-ML-01…06): версии GOLD-набора, реестр моделей, еженедельный отчёт. */
const MLOPS = ['ML_ENGINEER', 'ADMIN'] as const;
const READERS = ['ML_ENGINEER', 'ADMIN', 'SUPERVISOR'] as const;

export function mlHandlers(ctx: AppContext): Handlers {
  const { db, config, mlflow } = ctx;
  return {
    async listDatasetVersions(req) {
      requireRole(req, ...READERS);
      return listDatasetVersions(db);
    },

    async releaseDatasetVersion(req, reply) {
      const user = requireRole(req, ...MLOPS);
      const result = releaseDataset(db, user, req.body as S['DatasetReleaseRequest']);
      req.audit = {
        entity_type: 'dataset_version',
        entity_id: result.version,
        details: { items: result.items_count, new_items: result.new_items, split_hashes: result.split_hashes, excluded: result.excluded?.length ?? 0 },
      };
      mlflow.datasetReleased(result);
      reply.code(201);
      return result;
    },

    async exportDatasetVersion(req, reply) {
      requireRole(req, ...MLOPS);
      const { version } = req.params as { version: string };
      const { split } = req.query as { split?: S['DatasetSplit'] };
      const body = exportDataset(db, version, split);
      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${version}${split ? `-${split}` : ''}.jsonl"`);
      return body;
    },

    async listModelVersions(req) {
      requireRole(req, ...READERS);
      return listModels(db);
    },

    async registerModelVersion(req, reply) {
      const user = requireRole(req, ...MLOPS);
      const model = registerModel(db, user, req.body as S['ModelRegistration']);
      req.audit = { entity_type: 'model_version', entity_id: model.model_version, details: { dataset_version: model.dataset_version, thresholds_passed: model.thresholds_passed } };
      mlflow.modelRegistered(model);
      reply.code(201);
      return model;
    },

    async decideModelVersion(req) {
      const user = requireRole(req, ...MLOPS);
      const { model_version } = req.params as { model_version: string };
      const body = req.body as S['ModelDecisionRequest'];
      req.audit = { entity_type: 'model_version', entity_id: model_version, details: { action: body.action, comment: body.comment } };
      const model = decideModel(db, user, model_version, body);
      mlflow.modelDecided(model, body.action, body.comment, user.login);
      return model;
    },

    /**
     * Сессия MLflow: cookie на путь /mlflow, по ней Caddy пускает к MLflow
     * (GET /internal/auth/mlflow). Живёт столько же, сколько вход в api.
     */
    async createMlflowSession(req, reply) {
      const user = requireRole(req, ...MLFLOW_ROLES);
      if (!(await mlflow.healthy())) {
        throw new ApiError(503, 'MLFLOW_UNAVAILABLE', 'MLflow на этом стенде не запущен: включается `./start.sh --mlflow`');
      }
      const ttl = config.jwtTtlSeconds;
      const token = signSession(config.jwtSecret, user.id, user.role, ttl);
      const secure = req.protocol === 'https' ? '; Secure' : '';
      reply.header('set-cookie', `${MLFLOW_COOKIE}=${token}; Path=/mlflow; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure}`);
      req.audit = { entity_type: 'mlflow', details: { expires_in: ttl } };
      return { url: '/mlflow/', expires_in: ttl } satisfies S['MlflowSession'];
    },

    async getWeeklyReport(req) {
      requireRole(req, ...READERS);
      const { week } = req.query as { week?: string };
      return weeklyReport(db, week);
    },
  };
}
