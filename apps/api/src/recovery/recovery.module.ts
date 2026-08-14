import { Module } from '@nestjs/common';
import { RecoveryCaseService } from './recovery-case.service.js';

@Module({
  providers: [RecoveryCaseService],
  exports: [RecoveryCaseService],
})
export class RecoveryModule {}
