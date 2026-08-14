import { Module } from '@nestjs/common';
import { ReconcilerService } from './reconciler.service.js';

@Module({
  providers: [ReconcilerService],
  exports: [ReconcilerService],
})
export class ReconcilerModule {}
