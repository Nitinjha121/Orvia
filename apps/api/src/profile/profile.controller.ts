import { Body, Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CODE_LANGUAGES, DIFFICULTIES, INTERVIEW_MODES, MAX_DURATION_MINUTES, PERSONAS, VOICES } from '@orvia/shared';
import { profiles, jobDescriptions, type Database } from '@orvia/db';
import { DB } from '../db/db.module';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';

const profileSchema = z.object({
  experience: z.string().max(60_000).optional(),
  resume: z.string().max(60_000).optional(),
  targetRole: z.string().max(200).nullable().optional(),
  yearsExperience: z.number().min(0).max(60).nullable().optional(),
  defaultVoice: z.enum(VOICES).optional(),
  defaultDurationMinutes: z.number().int().min(5).max(MAX_DURATION_MINUTES).optional(),
  defaultDifficulty: z.enum(DIFFICULTIES).optional(),
  defaultPersona: z.enum(PERSONAS).optional(),
  /**
   * How long you may pause before the interviewer decides you have finished.
   * Exposed because it is the most taste-dependent setting in the product —
   * the difference between "it lets me think" and "it talks over me".
   */
  silenceDurationMs: z.number().int().min(400).max(4000).optional(),
  /**
   * How much sustained sound counts as you starting to talk. Raising it stops a
   * cough or a keystroke from triggering barge-in and cutting the interviewer
   * off mid-sentence.
   */
  prefixPaddingMs: z.number().int().min(100).max(2000).optional(),
  preferredLanguage: z.enum(CODE_LANGUAGES).optional(),
  /** The interview being prepared for, driving the Plan page's countdown and week. */
  targetCompany: z.string().trim().max(120).nullable().optional(),
  /** A calendar day in the reader's zone, never an instant — see `profiles.target_date`. */
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-12.').nullable().optional(),
  weeklyRounds: z.number().int().min(1).max(21).optional(),
  targetModes: z.array(z.enum(INTERVIEW_MODES)).max(INTERVIEW_MODES.length).optional(),
});

const jdSchema = z.object({
  label: z.string().min(1).max(120),
  company: z.string().max(120).nullable().optional(),
  content: z.string().min(50, 'Paste the full job description.'),
});

@Controller('api/profile')
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async get(@CurrentUser() user: PublicUser) {
    const [row] = await this.db.select().from(profiles).where(eq(profiles.userId, user.id));
    if (row) return row;
    // Two first loads at once (StrictMode, two tabs) both reach here; the loser
    // reads the winner's row rather than failing on the unique key.
    const [created] = await this.db
      .insert(profiles)
      .values({ userId: user.id })
      .onConflictDoNothing({ target: profiles.userId })
      .returning();
    if (created) return created;
    const [existing] = await this.db.select().from(profiles).where(eq(profiles.userId, user.id));
    return existing;
  }

  @Put()
  async update(@CurrentUser() user: PublicUser, @Body() body: unknown) {
    const patch = profileSchema.parse(body);
    const [row] = await this.db
      .insert(profiles)
      .values({ userId: user.id, ...patch })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /* ── saved job descriptions ─────────────────────────────────────────────── */

  @Get('job-descriptions')
  async listJds(@CurrentUser() user: PublicUser) {
    return this.db
      .select()
      .from(jobDescriptions)
      .where(eq(jobDescriptions.userId, user.id))
      .orderBy(desc(jobDescriptions.createdAt));
  }

  @Post('job-descriptions')
  async createJd(@CurrentUser() user: PublicUser, @Body() body: unknown) {
    const jd = jdSchema.parse(body);
    const [row] = await this.db
      .insert(jobDescriptions)
      .values({ userId: user.id, label: jd.label, company: jd.company ?? null, content: jd.content })
      .returning();
    return row;
  }

  @Delete('job-descriptions/:id')
  async deleteJd(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    const deleted = await this.db
      .delete(jobDescriptions)
      // Scoped by user as well as id — an id alone must never be enough to
      // reach another account's row.
      .where(and(eq(jobDescriptions.id, id), eq(jobDescriptions.userId, user.id)))
      .returning({ id: jobDescriptions.id });
    if (!deleted.length) throw new NotFoundException('No such job description.');
    return { ok: true };
  }
}
