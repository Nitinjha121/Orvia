import { Controller, Get, Inject } from '@nestjs/common';
import { MODELS, MODE_LABELS } from '@orvia/shared';
import { ModelAvailabilityService } from '../gemini/model-availability.service';
import { EvaluationService } from '../evaluation/evaluation.service';
import { ENV, type Env, basename, databaseName, isTestTarget } from '../config/env';

/** Unauthenticated on purpose — the web app pings this before sign-in. */
@Controller('api/health')
export class HealthController {
  constructor(
    private readonly availability: ModelAvailabilityService,
    private readonly evaluation: EvaluationService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  health() {
    return {
      ok: true,
      models: MODELS,
      modes: MODE_LABELS,
      // Cooling-off models are surfaced so quota exhaustion is visible rather
      // than showing up as a mysteriously slower or weaker report.
      unavailableModels: this.availability.status(),
      evaluatorProviders: this.evaluation.providerStatus(),
      /**
       * WHICH database and data directory this process writes to, so a suite
       * can refuse to talk to a real one. The suites never start an API, they
       * connect to one: with a dev server up on 8787, `pnpm test:e2e` recorded
       * two rounds into the real `orvia` and `apps/api/data/audio`, and the
       * DATABASE_URL the suite was given could not tell. Names only — no
       * credentials, no absolute paths.
       */
      target: {
        database: databaseName(this.env.DATABASE_URL),
        dataDir: basename(this.env.DATA_DIR),
        /** True when BOTH are clearly test targets. A suite requires this. */
        test: isTestTarget(this.env),
        /** Faults injected on purpose, so a suite can tell it has the stack it needs. */
        faults: isTestTarget(this.env) && this.env.E2E_FAULT_DEAF_AFTER_MS
          ? { deafAfterMs: this.env.E2E_FAULT_DEAF_AFTER_MS }
          : {},
      },
    };
  }
}
