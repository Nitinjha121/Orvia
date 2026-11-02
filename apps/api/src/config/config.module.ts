import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

/**
 * Global so every module — including DbModule and GeminiModule, which are
 * constructed before anything user-facing — can inject the validated env
 * without each one re-importing a config module.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: loadEnv }],
  exports: [ENV],
})
export class ConfigModule {}
