const jwt = require('jsonwebtoken');
const logger = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

/**
 * Middleware: Verify JWT access token from Authorization header.
 * Attaches decoded user payload (id, role) to req.user.
 */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, role, iat, exp }
    next();
  } catch (err) {
    logger.warn('JWT verification failed', { error: err.message });
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
};

/**
 * Middleware factory: Restrict access to specific roles.
 * Usage: requireRole('ADMIN', 'RECRUITER')
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${allowedRoles.join(' or ')}.` });
    }
    next();
  };
};

module.exports = { verifyToken, requireRole };
