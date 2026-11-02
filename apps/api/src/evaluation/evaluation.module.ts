import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EvaluationService } from './evaluation.service';
import { TranscriptionService } from './transcription.service';
import { CodeCheckService } from './code-check.service';
import { EvaluationController } from './evaluation.controller';
import { ProgressController } from './progress.controller';
import { RephraseService } from './rephrase.service';
import { RephraseController } from './rephrase.controller';

@Module({
  imports: [AuthModule],
  controllers: [EvaluationController, ProgressController, RephraseController],
  providers: [EvaluationService, TranscriptionService, CodeCheckService, RephraseService],
  exports: [EvaluationService],
})
export class EvaluationModule {}
