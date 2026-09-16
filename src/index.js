'use strict';

const { loadEnvironment } = require('./env');
const { MongoRealtime } = require('./server');

loadEnvironment();

/**
 * @typedef {object} MongoRealtimeGetOptions
 * @property {number|string} [limit] Maximum number of documents to return.
 * @property {Record<string, 1|-1|number|string>} [sort] Sort order specification (e.g. { createdAt: -1 }).
 */

/**
 * Public package export.
 *
 * @type {{
 *   MongoRealtime: typeof import('./server').MongoRealtime,
 *   get: (collectionName: string, filter?: object, options?: MongoRealtimeGetOptions) => Array<object>|Promise<Array<object>>
 * }}
 */
module.exports = {
  MongoRealtime,
  get: (collectionName, filter, options) =>
    MongoRealtime.get(collectionName, filter, options),
};

