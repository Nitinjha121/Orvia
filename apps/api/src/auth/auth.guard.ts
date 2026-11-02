import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type PublicUser } from './auth.service';

export const AUTH_COOKIE = 'orvia_session';

declare module 'express' {
  interface Request {
    user?: PublicUser;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) throw new UnauthorizedException('Not signed in.');

    const payload = await this.auth.verifyToken(token);
    if (!payload) throw new UnauthorizedException('Session expired.');

    const user = await this.auth.findById(payload.sub);
    if (!user) throw new UnauthorizedException('Account no longer exists.');

    req.user = user;
    return true;
  }
}

/** Only valid behind `AuthGuard`; throws rather than hand a handler `undefined`. */
export const CurrentUser = createParamDecorator((_data, ctx: ExecutionContext): PublicUser => {
  const user = ctx.switchToHttp().getRequest<Request>().user;
  if (!user) throw new UnauthorizedException('Not signed in.');
  return user;
});
