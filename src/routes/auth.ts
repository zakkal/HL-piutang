// ─── Auth Routes ───────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { loginSchema } from '../middleware/validation';
import { sendSuccess, sendError } from '../utils/response';
import { ValidationError } from '../utils/errors';
import { loginRateLimiter } from '../middleware/rateLimiter';

const router = Router();
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

// POST /auth/login
router.post('/login', loginRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map(i => i.message).join(', '));
    }

    const { email, password } = parsed.data;

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return sendError(res, 'Email atau password salah', undefined, 401);
    }

    sendSuccess(res, {
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_at: data.session?.expires_at,
      user: {
        id: data.user?.id,
        email: data.user?.email,
      },
    }, 'Login successful');
  } catch (err) {
    next(err);
  }
});

// POST /auth/change-password
router.post('/change-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      throw new ValidationError('Password baru minimal 6 karakter');
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return sendError(res, 'Sesi tidak valid, silakan login ulang', undefined, 401);
    }

    const token = authHeader.substring(7);
    const { createClient } = await import('@supabase/supabase-js');

    // Verifikasi user
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);
    if (userError || !user) {
      return sendError(res, 'Sesi tidak valid, silakan login ulang', undefined, 401);
    }

    // Buat hash SHA-256 dari password baru
    const { createHash } = await import('crypto');
    const newHash = createHash('sha256').update(newPassword).digest('hex');

    // Inisialisasi supabase admin
    const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    // Cek apakah password pernah digunakan sebelumnya
    const { data: history } = await supabaseAdmin
      .from('password_history')
      .select('pw_hash')
      .eq('user_id', user.id);

    if (history && history.some((h: any) => h.pw_hash === newHash)) {
      return sendError(res, 'Password ini pernah digunakan sebelumnya. Gunakan password yang berbeda.', undefined, 400);
    }

    // Update password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });
    if (updateError) {
      return sendError(res, 'Gagal mengubah password. Silakan coba lagi.', undefined, 400);
    }

    // Simpan hash ke histori
    await supabaseAdmin.from('password_history').insert({
      user_id: user.id,
      pw_hash: newHash,
    });

    // Re-login dengan password baru untuk dapat token segar
    const { data: newSession, error: loginError } = await supabaseAdmin.auth.signInWithPassword({
      email: user.email!,
      password: newPassword,
    });

    if (loginError || !newSession.session) {
      // Tetap sukses meski re-login gagal, frontend akan handle
      return sendSuccess(res, { new_token: null }, 'Password berhasil diubah');
    }

    sendSuccess(res, {
      new_token: newSession.session.access_token,
      new_refresh_token: newSession.session.refresh_token,
    }, 'Password berhasil diubah');
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      await supabase.auth.signOut();
    }
    sendSuccess(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
});

export default router;
