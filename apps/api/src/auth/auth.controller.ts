import { Body, Controller, Get, Inject, Post, Res, UseGuards, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthService } from './auth.service';
import { AuthGuard, CurrentUser, AUTH_COOKIE } from './auth.guard';
import type { PublicUser } from './auth.service';
import { ENV, type Env } from '../config/env';

const credentials = z.object({
  email: z.email(),
  password: z.string().min(8, 'Use at least 8 characters.'),
});
const registerSchema = credentials.extend({ name: z.string().min(1, 'Name is required.') });

/** 30 days — this is a personal practice tool, not a bank. */
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password, name } = registerSchema.parse(body);
    const user = await this.auth.register(email, password, name);
    await this.setCookie(res, user);
    return user;
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = credentials.parse(body);
    const user = await this.auth.login(email, password);
    await this.setCookie(res, user);
    return user;
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: PublicUser) {
    return user;
  }

  private async setCookie(res: Response, user: PublicUser) {
    // httpOnly so a script on the page can never read it, which also means the
    // browser attaches it to the WebSocket upgrade automatically.
    res.cookie(AUTH_COOKIE, await this.auth.issueToken(user), {
      httpOnly: true,
      sameSite: 'lax',
      // From the validated env rather than raw `process.env`, which is the
      // whole point of parsing it once at boot: a typo'd NODE_ENV here would
      // silently ship the session cookie over plain HTTP.
      secure: this.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
  }
}
