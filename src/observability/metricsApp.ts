import express from 'express';
import { type Metrics } from './metrics';

/**
 * Serves `GET /metrics` in Prometheus format on its own server, so the metrics stay off the public
 * port a reverse proxy forwards. Listen on an internal address only.
 */
export function createMetricsApp(metrics: Metrics): express.Express {
  const { registry } = metrics;
  const app = express();
  app.get('/metrics', (_req, res, next) => {
    registry.metrics()
      .then((body) => res.set('Content-Type', registry.contentType).send(body))
      .catch(next);
  });
  return app;
}
