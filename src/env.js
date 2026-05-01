"use strict";

const dotenv = require("dotenv");

let loaded = false;

/**
 * Loads environment variables from `.env` once for the current process.
 */
function loadEnvironment() {
  if (!loaded) {
    dotenv.config({
      quiet: true,
    });
    loaded = true;
  }
}

/**
 * Resolves runtime options from explicit overrides first, then environment variables.
 *
 * @param {object} [overrides={}] Explicit runtime overrides.
 * @param {string} [overrides.host] Host used when this package owns the HTTP server.
 * @param {number} [overrides.port] Port used when this package owns the HTTP server.
 * @param {string} [overrides.path] WebSocket upgrade path.
 * @param {string} [overrides.mongoUri] MongoDB connection URI.
 * @param {string} [overrides.dbName] MongoDB database name.
 * @param {number} [overrides.cacheTtlMs] Cache TTL in milliseconds.
 * @returns {{host: string, port: number, path: string, mongoUri: string, dbName: string, cacheTtlMs: number}}
 */
function readEnvironmentOptions(overrides = {}) {
  loadEnvironment();

  return {
    host: overrides.host || process.env.HOST || "0.0.0.0",
    port: normalizePort(overrides.port || process.env.PORT || 3000),
    path: overrides.path || process.env.WS_PATH || "/",
    mongoUri:
      overrides.mongoUri ||
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      "mongodb://127.0.0.1:27017",
    dbName:
      overrides.dbName ||
      process.env.MONGODB_DB_NAME ||
      process.env.MONGO_DB ||
      "mongo_realtime_test",
    cacheTtlMs:
      normalizeCacheTtlMs(overrides.cacheTtlMs) ||
      normalizeCacheTtlMs(process.env.CACHE_TTL_MS) ||
      normalizeCacheTtlMs(process.env.CACHE_TTL_SECONDS, { seconds: true }) ||
      5 * 60 * 1000,
  };
}

/**
 * @param {unknown} value Candidate TTL value.
 * @param {{seconds?: boolean}} [options]
 * @returns {number|undefined}
 */
function normalizeCacheTtlMs(value, options = {}) {
  if (typeof value === "string" && value.trim() !== "") {
    value = Number(value);
  }

  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    return undefined;
  }

  return options.seconds ? Math.round(value * 1000) : value;
}

/**
 * Normalizes a port value into a valid non-negative integer.
 *
 * @param {unknown} value Candidate port value.
 * @returns {number}
 */
function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 ? port : 3000;
}

module.exports = {
  loadEnvironment,
  readEnvironmentOptions,
};
