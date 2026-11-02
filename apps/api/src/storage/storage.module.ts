/**
 * Storage is global: the evaluation pipeline, the coach, the mentor and the
 * playback route all need `ensureLocal`, and threading it through four feature
 * modules would mean four chances to forget and read a path that is no longer
 * on disk.
 */
import { Global, Module } from '@nestjs/common';

import { ArchiveService } from './archive.service';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService, ArchiveService],
  exports: [StorageService, ArchiveService],
})
export class StorageModule {}
