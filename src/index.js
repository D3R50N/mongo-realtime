'use strict';

const { loadEnvironment } = require('./env');
const { MongoRealTimeServer } = require('./server');

loadEnvironment();

/**
 * Public package export.
 *
 * @type {{MongoRealTimeServer: typeof import('./server').MongoRealTimeServer}}
 */
module.exports = {
  MongoRealTimeServer,
};
