import { buildApp } from './app.js';

const { app, ctx } = await buildApp();

try {
  await app.listen({ port: ctx.config.port, host: ctx.config.host });
  app.log.info(
    `«Инспектор ИИ» api: http://localhost:${ctx.config.port} · ML: ${ctx.orchestrator.transport.kind}` +
      (ctx.orchestrator.transport.kind === 'http' ? ` (${ctx.config.ml.url})` : ' (заглушка)'),
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
