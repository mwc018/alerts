import { Router } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';

const router = Router();

const ALLOWED_DOMAINS = ['@ttalx.com', '@turnerteleco.onmicrosoft.com'];

function authUrl(path: string): string {
  return `https://login.microsoftonline.com/${config.auth.azureTenantId}/oauth2/v2.0/${path}`;
}

// /auth/login → show login page; /auth/start → kick off Microsoft OAuth
router.get('/login', (_req, res) => {
  res.redirect('/auth/login-page');
});

router.get('/start', (_req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, {
    httpOnly: true,
    secure: config.server.nodeEnv === 'production',
    maxAge: 10 * 60 * 1000,
    sameSite: 'lax',
  });

  const params = new URLSearchParams({
    client_id: config.auth.azureClientId,
    response_type: 'code',
    redirect_uri: `${config.auth.appUrl}/auth/callback`,
    scope: 'openid email profile',
    state,
    response_mode: 'query',
  });

  res.redirect(`${authUrl('authorize')}?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`Microsoft login error: ${error_description || error}`);
    return;
  }

  const storedState = req.cookies?.oauth_state;
  if (!state || state !== storedState) {
    res.status(400).send('Invalid state parameter — please try logging in again.');
    return;
  }

  res.clearCookie('oauth_state');

  try {
    const tokenResp = await axios.post(
      authUrl('token'),
      new URLSearchParams({
        client_id: config.auth.azureClientId,
        client_secret: config.auth.azureClientSecret,
        code,
        redirect_uri: `${config.auth.appUrl}/auth/callback`,
        grant_type: 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // Decode the ID token — we trust it since it came directly from Microsoft's token endpoint
    const idToken: string = tokenResp.data.id_token;
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')
    );
    const email: string = (payload.email || payload.preferred_username || '').toLowerCase();

    if (!ALLOWED_DOMAINS.some((d) => email.endsWith(d))) {
      res.status(403).send(
        `<h2>Access Denied</h2><p>Only Turner Teleco accounts may access this tool.</p>` +
        `<p>You signed in as <strong>${email}</strong>.</p><p><a href="/auth/logout">Sign out</a></p>`
      );
      return;
    }

    const authToken = jwt.sign({ email }, config.auth.jwtSecret, { expiresIn: '8h' });
    res.cookie('auth_token', authToken, {
      httpOnly: true,
      secure: config.server.nodeEnv === 'production',
      maxAge: 8 * 60 * 60 * 1000,
      sameSite: 'lax',
    });

    res.redirect('/admin');
  } catch (err: any) {
    console.error('[auth] Callback error:', err.response?.data || err.message);
    res.status(500).send('Authentication failed. Please <a href="/auth/login">try again</a>.');
  }
});

router.get('/logout', (req, res) => {
  res.clearCookie('auth_token');
  const params = new URLSearchParams({
    post_logout_redirect_uri: config.auth.appUrl,
  });
  res.redirect(`${authUrl('logout')}?${params}`);
});

export default router;
