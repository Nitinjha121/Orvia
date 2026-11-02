import { Global, Module } from '@nestjs/common';
import { GeminiLiveService } from './live-session.service';
import { ModelAvailabilityService } from './model-availability.service';

@Global()
@Module({
  providers: [GeminiLiveService, ModelAvailabilityService],
  exports: [GeminiLiveService, ModelAvailabilityService],
})
export class GeminiModule {}
