import { Global, Module } from '@nestjs/common';
import { ExtractionService } from './extraction.service';

@Global()
@Module({ providers: [ExtractionService], exports: [ExtractionService] })
export class ExtractionModule {}
