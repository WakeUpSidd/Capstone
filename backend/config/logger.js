/**
 * @file logger.js
 * @description Centralized logging configuration for the backend.
 * Provides structured logging with different levels and formats.
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Format a log message with timestamp and metadata
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} meta - Additional metadata
 * @returns {string} Formatted log message
 */
function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 
    ? ' ' + Object.entries(meta)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ')
    : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

/**
 * Truncate long strings for logging
 * @param {string} str - String to truncate
 * @param {number} maxLen - Maximum length
 * @returns {string} Truncated string
 */
function truncate(str, maxLen = 200) {
  if (typeof str !== 'string') return str;
  return str.length > maxLen ? `${str.slice(0, maxLen)}... [truncated ${str.length - maxLen} chars]` : str;
}

const logger = {
  error: (message, meta = {}) => {
    if (currentLevel >= LOG_LEVELS.ERROR) {
      console.error(formatLog('ERROR', message, meta));
    }
  },

  warn: (message, meta = {}) => {
    if (currentLevel >= LOG_LEVELS.WARN) {
      console.warn(formatLog('WARN', message, meta));
    }
  },

  info: (message, meta = {}) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      console.info(formatLog('INFO', message, meta));
    }
  },

  debug: (message, meta = {}) => {
    if (currentLevel >= LOG_LEVELS.DEBUG) {
      console.debug(formatLog('DEBUG', message, meta));
    }
  },

  /**
   * Log HTTP request details
   * @param {Object} req - Express request object
   * @param {Object} extra - Extra metadata
   */
  request: (req, extra = {}) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      const meta = {
        method: req.method,
        path: req.path,
        userId: req.user?.userId,
        ip: req.ip,
        ...extra,
      };
      console.info(formatLog('INFO', 'HTTP Request', meta));
    }
  },

  /**
   * Log HTTP response details
   * @param {Object} req - Express request object
   * @param {number} statusCode - Response status code
   * @param {number} durationMs - Request duration in milliseconds
   * @param {Object} extra - Extra metadata
   */
  response: (req, statusCode, durationMs, extra = {}) => {
    if (currentLevel >= LOG_LEVELS.INFO) {
      const meta = {
        method: req.method,
        path: req.path,
        status: statusCode,
        duration: `${durationMs}ms`,
        ...extra,
      };
      console.info(formatLog('INFO', 'HTTP Response', meta));
    }
  },

  truncate,
};

module.exports = logger;
