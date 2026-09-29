import { type AppContext, type Handlers, requireRole } from '../context.js';
import { ApiError, conflict } from '../errors.js';
import { RinError, inspectionResult } from '../modules/integration/index.js';
import { getProcessRow } from '../modules/repo.js';
import type { S } from '../types.js';

const OPERATORS = ['INSPECTOR', 'SUPERVISOR', 'ADMIN'] as const;

/** Обмен с внешней ИС надзора (REQ-INT-01…07). */
export function integrationHandlers(ctx: AppContext): Handlers {
  const { db, integration, config } = ctx;

  const requireEnabled = () => {
    if (!integration.enabled) throw conflict(`Обмен с ${config.rin.systemName} не настроен (RIN_URL)`, 'INTEGRATION_DISABLED');
  };

  return {
    async getInspectionResult(req) {
      const { process_id } = req.params as { process_id: string };
      return inspectionResult(db, process_id) satisfies S['InspectionResult'];
    },

    async pushInspectionResult(req, reply) {
      requireRole(req, ...OPERATORS);
      const { process_id } = req.params as { process_id: string };
      const info = integration.enqueue(process_id, 'MANUAL');
      const proc = getProcessRow(db, process_id);
      req.audit = { object_id: proc.object_id as string, entity_type: 'process', entity_id: process_id, details: { protocol_version: info.protocol_version } };
      reply.code(202);
      return info;
    },

    async getInspectionSync(req) {
      const { process_id } = req.params as { process_id: string };
      return integration.sync(process_id);
    },

    async getIntegrationStatus() {
      return integration.status();
    },

    async pullIntegrationPackages(req) {
      const user = requireRole(req, ...OPERATORS);
      requireEnabled();
      try {
        const packages = await integration.pull(user.id);
        req.audit = { entity_type: 'integration', details: { received: packages.map((p) => ({ package_id: p.package_id, status: p.status })) } };
        return { packages } satisfies S['IntegrationPullResult'];
      } catch (err) {
        if (err instanceof RinError) throw new ApiError(502, 'RIN_UNAVAILABLE', `${config.rin.systemName} недоступна: ${err.message}`);
        throw err;
      }
    },

    async listIntegrationPackages(req) {
      const { status } = req.query as { status?: S['IntegrationPackageStatus'] };
      return integration.packages(status);
    },

    async applyIntegrationPackage(req) {
      requireRole(req, ...OPERATORS);
      requireEnabled();
      const { package_id } = req.params as { package_id: string };
      const result = await integration.apply(package_id);
      req.audit = { object_id: result.object_id, entity_type: 'integration_package', entity_id: package_id, details: { status: result.status, process_id: result.process_id } };
      return result;
    },
  };
}
