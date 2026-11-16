import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';

function getToken(req: Request): string | undefined {
  return req.cookies?.auth_token;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getToken(req);
  if (!token) {
    res.redirect('/auth/login');
    return;
  }
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret) as { email: string };
    res.locals.user = payload;
    next();
  } catch {
    res.clearCookie('auth_token');
    res.redirect('/auth/login');
  }
}

export function requireAuthApi(req: Request, res: Response, next: NextFunction): void {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret) as { email: string };
    res.locals.user = payload;
    next();
  } catch {
    res.clearCookie('auth_token');
    res.status(401).json({ error: 'Unauthorized' });
  }
}
