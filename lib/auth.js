import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '24h';
const SALT_ROUNDS = 12;

export function getJwtSecret() {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required for auth.');
  }
  return JWT_SECRET;
}

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

export function signToken(payload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}

/**
 * Express middleware that requires a valid JWT.
 * Accepts token in Authorization header (Bearer) or __session cookie.
 * Sets req.user = { id, email, role } on success.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)__session=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  try {
    const decoded = verifyToken(token);
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid token.';
    res.status(401).json({ error: message });
  }
}

/**
 * Verify HMAC webhook signature (for Google Sheets / Apps Script).
 * Expects X-Webhook-Signature header with hex-encoded HMAC-SHA256.
 */
export function verifyWebhookSignature(secret) {
  return async (req, res, next) => {
    if (!secret) {
      res.status(500).json({ error: 'Webhook secret not configured.' });
      return;
    }

    const signature = req.headers['x-webhook-signature'];
    if (!signature) {
      res.status(401).json({ error: 'Missing webhook signature.' });
      return;
    }

    const crypto = await import('node:crypto');
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.warn('[WEBHOOK] HMAC mismatch — received:', signature.substring(0, 16) + '...', 'expected:', expected.substring(0, 16) + '...', 'hasRawBody:', !!req.rawBody, 'bodyLen:', rawBody.length, 'bodyPreview:', rawBody.toString('utf8').substring(0, 80));
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }

    next();
  };
}
