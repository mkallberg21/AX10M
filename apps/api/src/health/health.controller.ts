import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  service: 'lift-api';
  version: string;
  time: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    // TODO(lift): add readiness checks (DB, Redis, Temporal) distinct from liveness.
    return {
      status: 'ok',
      service: 'lift-api',
      version: process.env.npm_package_version ?? '0.1.0',
      time: new Date().toISOString(),
    };
  }
}
