import { Module } from '@nestjs/common';
import { GeminiModule } from '../gemini/gemini.module';
import { AuthModule } from '../auth/auth.module';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { PracticeModule } from '../practice/practice.module';
import { InterviewGateway } from './interview.gateway';
import { SessionService } from './session.service';
import { SessionHistoryService } from './session-history.service';
import { ReplayService } from './replay.service';
import { RecordingService } from './recording.service';
import { SessionsController } from './sessions.controller';
import { AudioController } from './audio.controller';
import { DrillService } from './drill.service';
import { RoundPracticeService } from './round-practice.service';

@Module({
  imports: [GeminiModule, AuthModule, EvaluationModule, PracticeModule],
  controllers: [SessionsController, AudioController],
  providers: [
    InterviewGateway,
    SessionService,
    SessionHistoryService,
    ReplayService,
    RecordingService,
    DrillService,
    RoundPracticeService,
  ],
  exports: [SessionService],
})
export class InterviewModule {}
