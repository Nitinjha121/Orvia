import {
  Controller, Delete, Get, Inject, NotFoundException, Param, ParseUUIDPipe, UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  coachConversations, coachMessages, mentorMemories, type Database,
} from '@orvia/db';
import { DB } from '../db/db.module';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import type { PublicUser } from '../auth/auth.service';

/**
 * REST endpoints for inspecting and deleting mentor memories and conversations.
 * Memories are read-and-delete only to preserve authentic observation records.
 */
@Controller('api/mentor')
@UseGuards(AuthGuard)
export class MentorController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('memories')
  async memories(@CurrentUser() user: PublicUser) {
    const rows = await this.db
      .select({
        id: mentorMemories.id,
        kind: mentorMemories.kind,
        content: mentorMemories.content,
        timesObserved: mentorMemories.timesObserved,
        sourceSessionId: mentorMemories.sourceSessionId,
        createdAt: mentorMemories.createdAt,
        updatedAt: mentorMemories.updatedAt,
      })
      .from(mentorMemories)
      .where(eq(mentorMemories.userId, user.id))
      .orderBy(desc(mentorMemories.updatedAt));
    return rows;
  }

  @Delete('memories/:id')
  async forget(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    // Scoped by user as well as id — an id alone must never reach another
    // account's memory.
    const [gone] = await this.db
      .delete(mentorMemories)
      .where(and(eq(mentorMemories.id, id), eq(mentorMemories.userId, user.id)))
      .returning({ id: mentorMemories.id });
    if (!gone) throw new NotFoundException('No such memory.');
    return { forgotten: true };
  }

  @Get('conversations')
  async conversations(@CurrentUser() user: PublicUser) {
    return this.db
      .select({
        id: coachConversations.id,
        scope: coachConversations.scope,
        sessionId: coachConversations.sessionId,
        startedAt: coachConversations.startedAt,
        durationMs: coachConversations.durationMs,
        messageCount: coachConversations.messageCount,
      })
      .from(coachConversations)
      .where(eq(coachConversations.userId, user.id))
      .orderBy(desc(coachConversations.startedAt))
      .limit(100);
  }

  @Get('conversations/:id')
  async conversation(@CurrentUser() user: PublicUser, @Param('id', ParseUUIDPipe) id: string) {
    const [row] = await this.db
      .select()
      .from(coachConversations)
      .where(and(eq(coachConversations.id, id), eq(coachConversations.userId, user.id)));
    if (!row) throw new NotFoundException('No such conversation.');

    const messages = await this.db
      .select({
        idx: coachMessages.idx,
        speaker: coachMessages.speaker,
        text: coachMessages.text,
        atMs: coachMessages.atMs,
      })
      .from(coachMessages)
      .where(eq(coachMessages.conversationId, id))
      .orderBy(asc(coachMessages.idx));

    return { ...row, messages };
  }

  @Delete('conversations/:id')
  async deleteConversation(
    @CurrentUser() user: PublicUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const [gone] = await this.db
      .delete(coachConversations)
      .where(and(eq(coachConversations.id, id), eq(coachConversations.userId, user.id)))
      .returning({ id: coachConversations.id });
    if (!gone) throw new NotFoundException('No such conversation.');
    return { deleted: true };
  }
}
