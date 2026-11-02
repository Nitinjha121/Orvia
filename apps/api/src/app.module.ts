import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { ProfileModule } from './profile/profile.module';
import { QuestionBankModule } from './question-bank/question-bank.module';
import { ExtractionModule } from './extraction/extraction.module';
import { EvaluationModule } from './evaluation/evaluation.module';
import { InterviewModule } from './interview/interview.module';
import { CoachModule } from './coach/coach.module';
import { FeedModule } from './feed/feed.module';
import { PracticeModule } from './practice/practice.module';

import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule,
    StorageModule,
    DbModule,
    AuthModule,
    HealthModule,
    ProfileModule,
    QuestionBankModule,
    ExtractionModule,
    EvaluationModule,
    InterviewModule,
    CoachModule,
    FeedModule,
    PracticeModule,
  ],
})
export class AppModule {}
