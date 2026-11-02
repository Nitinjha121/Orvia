import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SURPRISE_MODES, type SurpriseMode } from '@orvia/shared';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';
import { QuestionBankService } from './question-bank.service';
import { PracticeRotationService } from './practice-rotation.service';

/**
 * Question catalogue endpoints. Bank queries are public, while user attempt
 * and resolve histories are authenticated.
 */
@Controller('api/questions')
export class QuestionBankController {
  constructor(
    private readonly bank: QuestionBankService,
    private readonly rotation: PracticeRotationService,
  ) {}

  @Get('collections')
  collections() {
    return this.bank.collections();
  }

  @Get('dsa')
  listDsa(@Query('collection') collection?: string) {
    return this.bank.listDsa(collection);
  }

  @Get('concept-topics')
  conceptTopics() {
    return this.bank.conceptTopics();
  }

  @Get('concepts')
  listConcepts(@Query('topic') topic?: string) {
    return this.bank.listConcepts(topic);
  }

  @Get('competencies')
  competencies() {
    return this.bank.competencies();
  }

  @Get('behavioural')
  listBehavioural(@Query('competency') competency?: string) {
    return this.bank.listBehavioural(competency);
  }

  @Get('hr-scenarios')
  listHrScenarios() {
    return this.bank.listHrScenarios();
  }

  @Get('system-design')
  listSystemDesign() {
    return this.bank.listSystemDesign();
  }

  /**
   * Which questions this account has already been handed — see
   * `PracticeRotationService`.
   */
  @Get('attempted')
  @UseGuards(AuthGuard)
  attempted(@CurrentUser() user: PublicUser, @Query('mode') modeParam?: string) {
    /**
     * Defaults to `dsa` so every client written before the other two modes had
     * a draw keeps working unchanged.
     */
    const mode = (modeParam ?? 'dsa') as SurpriseMode;
    if (!SURPRISE_MODES.includes(mode)) {
      throw new BadRequestException(
        `mode must be one of ${SURPRISE_MODES.join(', ')} — got "${modeParam}"`,
      );
    }
    return this.rotation.attempted(user.id, mode);
  }

  /** The DSA verdicts the re-solve queue folds — see `resolveQueue`. */
  @Get('resolve')
  @UseGuards(AuthGuard)
  resolve(@CurrentUser() user: PublicUser) {
    return this.rotation.resolveHistory(user.id);
  }
}
