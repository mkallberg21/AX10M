import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  service: 'ax10m-api';
  version: string;
  time: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    // TODO(ax10m): add readiness checks (DB, Redis, Temporal) distinct from liveness.
    return {
      status: 'ok',
      service: 'ax10m-api',
      version: process.env.npm_package_version ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
