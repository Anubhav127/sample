/**
 * attemptGuard.js
 * In-memory IP-based attempt tracker for uninstall password verification.
 * Lockout resets only on server restart.
 */

const MAX_ATTEMPTS = 3;

// Map<ip, attemptCount>
const attemptStore = new Map();

function getAttemptCount(ip) {
  return attemptStore.get(ip) || 0;
}

function incrementAttempt(ip) {
  const current = getAttemptCount(ip);
  attemptStore.set(ip, current + 1);
  return current + 1;
}

function isLockedOut(ip) {
  return getAttemptCount(ip) >= MAX_ATTEMPTS;
}

function getRemainingAttempts(ip) {
  return Math.max(0, MAX_ATTEMPTS - getAttemptCount(ip));
}

function attemptGuard(req, res, next) {
  const ip = req.ip;

  if (isLockedOut(ip)) {
    return res.status(403).json({
      success: false,
      attemptsRemaining: 0,
      message: "Maximum attempts exceeded. Contact your administrator.",
    });
  }

  // Attach helpers to req so route can use them
  req.attemptGuard = {
    increment: () => incrementAttempt(ip),
    remaining: () => getRemainingAttempts(ip),
    isLockedOut: () => isLockedOut(ip),
  };

  next();
}

module.exports = attemptGuard;
