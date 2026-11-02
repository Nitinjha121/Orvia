import { Injectable, Inject, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { users, profiles, type Database } from '@orvia/db';
import { DB } from '../db/db.module';

export type JwtPayload = { sub: string; email: string };
export type PublicUser = { id: string; email: string; name: string };

/**
 * argon2id at interactive-login cost. Not bcrypt: the application stores
 * career history and recorded interviews.
 */
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string, name: string): Promise<PublicUser> {
    const normalised = email.trim().toLowerCase();
    // The unique key decides, not a select beforehand: two registrations racing
    // both pass a pre-check and the loser surfaced as a 500.
    const [row] = await this.db
      .insert(users)
      .values({ email: normalised, name: name.trim(), passwordHash: await hash(password, ARGON) })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, name: users.name });
    if (!row) throw new ConflictException('That email is already registered.');

    // Every user gets a profile row immediately, so the rest of the app can
    // read defaults without a null check on every single query.
    await this.db.insert(profiles).values({ userId: row.id }).onConflictDoNothing();
    return row;
  }

  async login(email: string, password: string): Promise<PublicUser> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));

    // Same rejection for unknown email and wrong password, so the endpoint
    // cannot be used to enumerate which addresses have accounts.
    if (!row || !(await verify(row.passwordHash, password).catch(() => false))) {
      throw new UnauthorizedException('Incorrect email or password.');
    }

    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
    return { id: row.id, email: row.email, name: row.name };
  }

  async issueToken(user: PublicUser): Promise<string> {
    return this.jwt.signAsync({ sub: user.id, email: user.email } satisfies JwtPayload);
  }

  async verifyToken(token: string): Promise<JwtPayload | null> {
    try {
      return await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      return null;
    }
  }

  async findById(id: string): Promise<PublicUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, id));
    return row ?? null;
  }
}
