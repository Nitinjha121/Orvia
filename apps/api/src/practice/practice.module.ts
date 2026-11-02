import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommitmentsService } from './commitments.service';
import { LoopsService } from './loops.service';
import { PlanService } from './plan.service';
import { CommitmentsController, LoopsController, PlanController } from './practice.controller';

@Module({
  imports: [AuthModule],
  controllers: [CommitmentsController, LoopsController, PlanController],
  providers: [CommitmentsService, LoopsService, PlanService],
  exports: [CommitmentsService, LoopsService],
})
export class PracticeModule {}
