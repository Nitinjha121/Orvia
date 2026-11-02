import { Module } from '@nestjs/common';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { HealthController } from './health.controller';

/**
 * `GeminiModule` is global, so `ModelAvailabilityService` needs no import here.
 * `EvaluationModule` is not, and the health response names which evaluator
 * providers are actually wired.
 */
@Module({
  imports: [EvaluationModule],
  controllers: [HealthController],
})
export class HealthModule {}
