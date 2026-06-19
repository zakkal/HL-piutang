// ─── Auth Middleware ────────────────────────────────────────────
// Verifies Supabase JWT token and ensures user is authenticated.
// Sessions auto-expire after 15 minutes of inactivity.

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { AuthError } from '../utils/errors';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SESSION_TIMEOUT_MINUTES = Number(process.env.SESSION_TIMEOUT_MINUTES) || 15;

// Track last activity per user for idle timeout
const lastActivity = new Map<string, number>();

function isSessionExpired(userId: string, now: number): boolean {
  const last = lastActivity.get(userId);
  if (!last) return false;
  return (now - last) > SESSION_TIMEOUT_MINUTES * 60 * 1000;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthError('Header Authorization tidak valid');
    }

    const token = authHeader.substring(7);

    // Verify token with Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new AuthError('Sesi tidak valid atau telah berakhir. Silakan login ulang.');
    }

    // Check idle session timeout
    const now = Date.now();
    if (isSessionExpired(user.id, now)) {
      lastActivity.delete(user.id);
      throw new AuthError('Sesi berakhir karena tidak ada aktivitas. Silakan login ulang.');
    }

    // Update last activity
    lastActivity.set(user.id, now);

    // Attach user info to request
    (req as any).user = user;
    (req as any).accessToken = token;

    next();
  } catch (err) {
    if (err instanceof AuthError) {
      next(err);
    } else {
      next(new AuthError('Autentikasi gagal. Silakan login ulang.'));
    }
  }
}

// Cleanup stale sessions periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, last] of lastActivity.entries()) {
    if (now - last > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
      lastActivity.delete(userId);
    }
  }
}, 10 * 60 * 1000);
