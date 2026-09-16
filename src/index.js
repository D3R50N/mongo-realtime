'use strict';

const { loadEnvironment } = require('./env');
const { MongoRealtime } = require('./server');

loadEnvironment();

/**
 * Public package export.
 *
 * @type {{
 *   MongoRealtime: typeof import('./server').MongoRealtime,
 *   get: (collectionName: string, filter?: object) => Array<object>|Promise<Array<object>>
 * }}
 */
module.exports = {
  MongoRealtime,
  get: (collectionName, filter) => MongoRealtime.get(collectionName, filter),
};

