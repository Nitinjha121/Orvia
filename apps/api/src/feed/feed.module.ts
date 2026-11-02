import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';
import { FeedSignalsService } from './feed-signals.service';
import { SpeechCacheService } from './speech-cache.service';

@Module({
  imports: [AuthModule],
  controllers: [FeedController],
  providers: [FeedService, FeedSignalsService, SpeechCacheService],
})
export class FeedModule {}
