import { Module } from '@nestjs/common';
import { GeminiModule } from '../gemini/gemini.module';
import { AuthModule } from '../auth/auth.module';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { QuestionBankModule } from '../question-bank/question-bank.module';
import { CoachGateway } from './coach.gateway';
import { MentorController } from './mentor.controller';
import { MentorDataService } from './mentor-data.service';
import { MentorToolsService } from './mentor-tools.service';
import { MentorCatalogueService } from './mentor-catalogue.service';
import { ListeningService } from './listening.service';

@Module({
  // The banks come from `QuestionBankModule` rather than being re-queried here,
  // so the mentor reads them through the same redaction the browser does.
  imports: [GeminiModule, AuthModule, EvaluationModule, QuestionBankModule],
  controllers: [MentorController],
  providers: [CoachGateway, MentorDataService, MentorToolsService, MentorCatalogueService, ListeningService],
})
export class CoachModule {}
