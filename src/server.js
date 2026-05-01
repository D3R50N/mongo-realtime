"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const { MongoClient, ObjectId } = require("mongodb");
const { WebSocketServer } = require("ws");

const { readEnvironmentOptions } = require("./env");
const {
  deepCopy,
  isMongoOperatorUpdate,
  isPlainObject,
  matchesFilter,
} = require("./query");
const Stream = require("node:stream");

/**
 * MongoRealTime WebSocket server backed by MongoDB.
 *
 * By default the server reads its configuration from `.env` through `dotenv`.
 * You can either let it create and own its HTTP server, or attach it to an
 * existing HTTP server such as one created for Express.
 */
class MongoRealTimeServer {
  #mongoClient;
  #ownsMongoClient;
  #db;
  #ownsHttpServer;
  #httpServer;
  #wss;
  #started;
  #authenticate;
  #upgradeAttached;
  #connectionAttached;
  #socketSubscriptions;
  #subscriptions;
  #eventHandlers;
  #queryCache;
  #cacheTtlMs;
  /**
   * @param {object} [options={}] Server configuration.
   * @param {string} [options.host] Host used when this package owns the HTTP server.
   * @param {number} [options.port] Port used when this package owns the HTTP server.
   * @param {string} [options.path] WebSocket upgrade path. Defaults to `/`.
   * @param {string} [options.mongoUri] MongoDB connection URI.
   * @param {string} [options.dbName] MongoDB database name.
   * @param {number} [options.cacheTtlMs] Cache TTL in milliseconds.
   * @param {(authData:any)=>Promise<boolean>} [options.authenticate] Cache TTL in milliseconds.
   * @param {import('node:http').Server} [options.server] Existing HTTP server to attach to.
   * @param {import('mongodb').MongoClient} [options.mongoClient] Existing Mongo client to reuse.
   * @param {import('mongodb').Db} [options.db] Existing Mongo database handle to reuse.
   * @param {{info?: Function, warn?: Function}} [options.logger] Logger compatible with `console`.
   */
  constructor(options = {}) {
    const resolved = readEnvironmentOptions(options);

    this.host = resolved.host;
    this.port = resolved.port;
    this.path = resolved.path;
    this.mongoUri = resolved.mongoUri;
    this.dbName = resolved.dbName;
    this.logger = options.logger ?? console;
    this.#authenticate = options.authenticate;
    this.#mongoClient = options.mongoClient ?? null;
    this.#ownsMongoClient = !options.mongoClient;
    this.#db =
      options.db ??
      (options.mongoClient ? options.mongoClient.db(this.dbName) : null);

    this.#ownsHttpServer = !options.server;
    this.#httpServer = options.server ?? http.createServer();
    this.#wss = new WebSocketServer({ noServer: true });
    this.#started = false;
    this.#upgradeAttached = false;
    this.#connectionAttached = false;

    this.#socketSubscriptions = new Map();
    this.#subscriptions = new Map();
    this.#eventHandlers = new Map();
    this.#queryCache = new Map();
    this.#cacheTtlMs = Number.isInteger(resolved.cacheTtlMs)
      ? resolved.cacheTtlMs
      : 5 * 60 * 1000;

    if (
      !this.#ownsHttpServer &&
      (options.host != null || options.port != null)
    ) {
      this.logger.warn?.(
        'MongoRealTimeServer received "host" or "port" with an external HTTP server; those options are ignored.',
      );
    }
  }

  /**
   * Registers a custom event handler for `realtime:emit` messages.
   *
   * @param {string} eventName Custom event name.
   * @param {(payload: any, context: {socket: any, server: MongoRealTimeServer, requestId?: string}) => any | Promise<any>} handler
   * @returns {MongoRealTimeServer}
   */
  on(eventName, handler) {
    if (typeof eventName !== "string" || eventName.trim() === "") {
      throw new TypeError('Expected "eventName" to be a non-empty string.');
    }
    if (typeof handler !== "function") {
      throw new TypeError('Expected "handler" to be a function.');
    }

    this.#eventHandlers.set(eventName, handler);
    return this;
  }

  /**
   * Connects MongoDB, attaches WebSocket handlers, and starts listening when
   * the package owns the HTTP server.
   *
   * @returns {Promise<MongoRealTimeServer>}
   */
  async start() {
    if (this.#started) {
      return this;
    }

    await this.#connectMongo();

    if (!this.#connectionAttached) {
      this.#connectionAttached = true;
      this.#wss.on("connection", (socket, req, stream) =>
        this.#handleConnection(socket, req, stream),
      );
    }

    if (!this.#upgradeAttached) {
      this.#upgradeAttached = true;
      this.#httpServer.on("upgrade", async (request, socket, head) => {
        if (toPathname(request.url) !== this.path) {
          socket.destroy();
          return;
        }

        this.#wss.handleUpgrade(request, socket, head, (webSocket) => {
          this.#wss.emit("connection", webSocket, request, socket);
        });
      });
    }

    if (this.#ownsHttpServer) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.#httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.#httpServer.off("error", onError);
          resolve();
        };

        this.#httpServer.once("error", onError);
        this.#httpServer.once("listening", onListening);
        this.#httpServer.listen(this.port, this.host);
      });
    }

    await this.#listenInternHandlers();

    this.#started = true;
    if (this.#ownsHttpServer) {
      this.logger.info?.(
        `MongoRealTime server listening on ws://${this.host}:${this.port}${this.path}`,
      );
    } else {
      this.logger.info?.(
        `MongoRealTime server attached to an external HTTP server on path ${this.path}`,
      );
    }

    return this;
  }

  async #listenInternHandlers() {
    const collections = await this.#db.listCollections().toArray();
    for (let c of collections) {
      this.collection(c.name)
        .watch([], {
          fullDocument: "updateLookup",
        })
        .on("change", (change) => {
          Promise.resolve(this.#handleCacheChange(c.name, change)).catch(
            () => {},
          );

          const callHandler = (type = "change", docId = "") => {
            let eventName = `db:${type}:${c.name}`;
            if (!!docId) eventName += `:${docId}`;
            const handler = this.#eventHandlers.get(eventName);
            try {
              handler?.(change);
            } catch (_) {}
          };

          callHandler("change");
          callHandler(change.operationType);
          callHandler("change", change.documentKey._id);
          callHandler(change.operationType, change.documentKey._id);
        });
    }
  }

  /**
   * Stops subscriptions, closes sockets, and releases owned Mongo/HTTP resources.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    const activeSubscriptions = Array.from(this.#subscriptions.keys());
    await Promise.all(
      activeSubscriptions.map((queryId) => this.#unsubscribe(queryId)),
    );

    for (const socket of this.#socketSubscriptions.keys()) {
      try {
        socket.close();
      } catch {}
    }
    this.#socketSubscriptions.clear();

    await new Promise((resolve) => this.#wss.close(() => resolve()));

    if (this.#ownsHttpServer) {
      await new Promise((resolve, reject) => {
        this.#httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (this.#ownsMongoClient && this.#mongoClient) {
      await this.#mongoClient.close();
    }

    this.#clearQueryCache();
    this.#started = false;
  }

  /**
   *
   * @param {import('ws').WebSocket} socket
   * @param {http.IncomingMessage} req
   * @param {Stream.Duplex} stream
   */
  async #handleConnection(socket, req, stream) {
    this.#socketSubscriptions.set(socket, new Set());

    if (typeof this.#authenticate === "function") {
      let authData = req.headers.auth;
      try {
        authData = JSON.parse(authData);
      } catch (_) {}

      let authenticated = false;
      try {
        authenticated = await this.#authenticate(authData);
      } catch (_) {}

      if (!authenticated) {
        this.#sendError(socket, "Socket authentification failed");
        stream.destroy();
        socket.close();
        return;
      }
    }

    socket.on("message", (buffer) => {
      Promise.resolve(this.#handleMessage(socket, buffer)).catch((error) => {
        this.#sendError(socket, error);
      });
    });

    socket.on("close", () => {
      Promise.resolve(this.#cleanupSocketSubscriptions(socket)).catch(
        (error) => {
          this.logger.warn?.(
            `MongoRealTime socket cleanup failed: ${error.message}`,
          );
        },
      );
    });

    socket.on("error", (error) => {
      this.logger.warn?.(`MongoRealTime socket error: ${error.message}`);
    });
  }

  async #handleMessage(socket, buffer) {
    const message = parsePayload(buffer);

    switch (message.type) {
      case "realtime:subscribe":
        await this.#subscribe(socket, message);
        return;
      case "realtime:unsubscribe":
        await this.#unsubscribe(String(message.queryId ?? ""));
        return;
      case "realtime:fetch":
        await this.#fetch(socket, message);
        return;
      case "realtime:insert":
        await this.#insert(message);
        return;
      case "realtime:update":
        await this.#update(message);
        return;
      case "realtime:delete":
        await this.#delete(message);
        return;
      case "realtime:emit":
        await this.#emit(socket, message);
        return;
      default:
        throw new Error(`Unsupported message type "${message.type}".`);
    }
  }

  async #subscribe(socket, message) {
    const query = normalizeQuery(message);
    await this.#unsubscribe(query.queryId);

    const collection = this.collection(query.collection);
    const documents = await this.#findDocuments(collection, query);
    const changeStream = collection.watch([], { fullDocument: "updateLookup" });

    const subscription = {
      socket,
      query,
      collection,
      changeStream,
    };

    this.#subscriptions.set(query.queryId, subscription);
    this.#socketSubscriptions.get(socket)?.add(query.queryId);

    changeStream.on("change", (change) => {
      Promise.resolve(this.#forwardChange(query.queryId, change)).catch(
        (error) => {
          this.#sendError(socket, error, query.queryId);
        },
      );
    });

    changeStream.on("error", (error) => {
      this.#sendError(socket, error, query.queryId);
    });

    this.#send(socket, {
      type: "realtime:initial",
      collection: query.collection,
      queryId: query.queryId,
      documents,
    });
  }

  async #fetch(socket, message) {
    const query = normalizeQuery(message);
    const documents = await this.#findDocuments(
      this.collection(query.collection),
      query,
    );

    this.#send(socket, {
      type: "realtime:initial",
      collection: query.collection,
      queryId: query.queryId,
      documents,
    });
  }

  async #unsubscribe(queryId) {
    if (!queryId) {
      return;
    }

    const subscription = this.#subscriptions.get(queryId);
    if (!subscription) {
      return;
    }

    this.#subscriptions.delete(queryId);
    this.#socketSubscriptions.get(subscription.socket)?.delete(queryId);
    await subscription.changeStream.close();
  }

  async #cleanupSocketSubscriptions(socket) {
    const queryIds = Array.from(this.#socketSubscriptions.get(socket) ?? []);
    this.#socketSubscriptions.delete(socket);
    await Promise.all(queryIds.map((queryId) => this.#unsubscribe(queryId)));
  }

  async #insert(message) {
    const collection = this.collection(
      requiredString(message.collection, "collection"),
    );
    const document = prepareDocumentForWrite(
      requiredObject(message.document, "document"),
    );
    await collection.insertOne(document);
  }

  async #update(message) {
    const collection = this.collection(
      requiredString(message.collection, "collection"),
    );
    const filter = prepareFilter(optionalObject(message.filter));
    const update = normalizeMongoUpdate(
      requiredObject(message.update, "update"),
    );

    ensureUpdateDoesNotChangeId(update);
    await collection.updateMany(filter, update);
  }

  async #delete(message) {
    const collection = this.collection(
      requiredString(message.collection, "collection"),
    );
    const filter = prepareFilter(optionalObject(message.filter));
    await collection.deleteMany(filter);
  }

  async #emit(socket, message) {
    const eventName = requiredString(message.event, "event");
    let requestId =
      typeof message.requestId === "string" ? message.requestId : undefined;
    const handler = this.#eventHandlers.get(eventName);

    if (!handler) {
      if (requestId) {
        this.#send(socket, {
          type: "realtime:emit:error",
          event: eventName,
          requestId,
          error: `No handler registered for event "${eventName}".`,
        });
        return;
      }

      throw new Error(`No handler registered for event "${eventName}".`);
    }

    try {
      const result = await handler(message.payload, {
        socket,
        server: this,
        requestId,
      });

      requestId ||= "";
      this.#send(socket, {
        type: "realtime:emit:result",
        event: eventName,
        requestId,
        data: result ?? null,
      });
    } catch (error) {
      if (requestId) {
        this.#send(socket, {
          type: "realtime:emit:error",
          event: eventName,
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      throw error;
    }
  }

  async #forwardChange(queryId, change) {
    const subscription = this.#subscriptions.get(queryId);
    if (!subscription) {
      return;
    }

    const { socket, query, collection } = subscription;
    if (socket.readyState !== 1) {
      return;
    }

    const payload = await this.#buildChangePayload(collection, query, change);
    if (!payload) {
      return;
    }

    this.#send(socket, payload);
  }

  async #buildChangePayload(collection, query, change) {
    const collectionName = query.collection;

    switch (change.operationType) {
      case "insert": {
        const document = serializeDocument(change.fullDocument);
        if (!document || !matchesFilter(document, query.filter)) {
          return null;
        }

        return {
          type: "realtime:insert",
          collection: collectionName,
          document,
        };
      }
      case "replace":
      case "update": {
        const id = serializeId(change.documentKey?._id);
        if (!id) {
          return null;
        }

        const before = await this.#findOneById(collection, id);
        const current = serializeDocument(change.fullDocument);
        const matchedBefore = before
          ? matchesFilter(before, query.filter)
          : false;
        const matchedAfter = current
          ? matchesFilter(current, query.filter)
          : false;

        if (!matchedBefore && !matchedAfter) {
          return null;
        }

        return {
          type: "realtime:update",
          collection: collectionName,
          document: current,
          before,
        };
      }
      case "delete": {
        const id = serializeId(change.documentKey?._id);
        if (!id) {
          return null;
        }

        return {
          type: "realtime:delete",
          collection: collectionName,
          documentId: id,
        };
      }
      default:
        return null;
    }
  }

  collection(collectionName) {
    return this.#db.collection(collectionName);
  }

  #setQueryCacheEntry(collectionName, cacheKey, query, documents) {
    const collectionCache = this.#getQueryCacheForCollection(collectionName);
    const existing = collectionCache.get(cacheKey);

    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }

    const timeoutId = setTimeout(() => {
      this.#deleteQueryCacheEntry(collectionName, cacheKey);
    }, this.#cacheTtlMs);

    collectionCache.set(cacheKey, {
      query,
      documents,
      expiresAt: Date.now() + this.#cacheTtlMs,
      timeoutId,
    });
  }

  #deleteQueryCacheEntry(collectionName, cacheKey) {
    const collectionCache = this.#queryCache.get(collectionName);
    if (!collectionCache) {
      return;
    }

    const entry = collectionCache.get(cacheKey);
    if (!entry) {
      return;
    }

    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }

    collectionCache.delete(cacheKey);
  }

  #clearQueryCacheForCollection(collectionName) {
    const collectionCache = this.#queryCache.get(collectionName);
    if (!collectionCache) {
      return;
    }

    for (const [cacheKey] of collectionCache.entries()) {
      this.#deleteQueryCacheEntry(collectionName, cacheKey);
    }
  }

  #clearQueryCache() {
    for (const collectionName of this.#queryCache.keys()) {
      this.#clearQueryCacheForCollection(collectionName);
    }
  }

  #getQueryCacheForCollection(collectionName) {
    let collectionCache = this.#queryCache.get(collectionName);
    if (!collectionCache) {
      collectionCache = new Map();
      this.#queryCache.set(collectionName, collectionCache);
    }
    return collectionCache;
  }

  async #handleCacheChange(collectionName, change) {
    const collectionCache = this.#queryCache.get(collectionName);
    if (!collectionCache || collectionCache.size === 0) {
      return;
    }

    for (const [cacheKey, cached] of collectionCache.entries()) {
      const query = cached.query;
      if (this.#shouldRebuildCacheForQuery(query)) {
        await this.#rebuildCachedQueryEntry(collectionName, cacheKey, query);
        continue;
      }

      const existingIndex = cached.documents.findIndex(
        (document) => document._id === serializeId(change.documentKey?._id),
      );

      switch (change.operationType) {
        case "insert": {
          const document = serializeDocument(change.fullDocument);
          if (!document || !matchesFilter(document, query.filter)) {
            break;
          }
          cached.documents.push(document);
          break;
        }
        case "replace":
        case "update": {
          const document = serializeDocument(change.fullDocument);
          const matchesAfter = document
            ? matchesFilter(document, query.filter)
            : false;

          if (existingIndex >= 0) {
            if (matchesAfter) {
              cached.documents[existingIndex] = document;
            } else {
              cached.documents.splice(existingIndex, 1);
            }
          } else if (matchesAfter) {
            cached.documents.push(document);
          }
          break;
        }
        case "delete": {
          if (existingIndex >= 0) {
            cached.documents.splice(existingIndex, 1);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  #shouldRebuildCacheForQuery(query) {
    return (
      Object.keys(query.sort).length > 0 || typeof query.limit === "number"
    );
  }

  async #rebuildCachedQueryEntry(collectionName, cacheKey, query) {
    const collection = this.collection(collectionName);
    const documents = await this.#findDocuments(collection, query, {
      useCache: false,
    });
    this.#setQueryCacheEntry(collectionName, cacheKey, query, documents);
  }

  #getQueryCacheKey(collection, query) {
    return JSON.stringify({
      collection,
      filter: query.filter ?? {},
      sort: query.sort ?? {},
      limit: query.limit,
    });
  }

  async #findDocuments(collection, query, options = { useCache: true }) {
    const cacheKey = this.#getQueryCacheKey(collection.collectionName, query);
    const collectionCache = this.#getQueryCacheForCollection(
      collection.collectionName,
    );
    const cached = options.useCache ? collectionCache.get(cacheKey) : undefined;
    if (cached) {
      if (cached.expiresAt == null || cached.expiresAt > Date.now()) {
        return cached.documents.map((doc) => deepCopy(doc));
      }
      this.#deleteQueryCacheEntry(collection.collectionName, cacheKey);
    }

    let cursor = collection.find(prepareFilter(query.filter));
    if (Object.keys(query.sort).length > 0) {
      cursor = cursor.sort(query.sort);
    }

    if (typeof query.limit === "number") {
      cursor = cursor.limit(query.limit);
    }

    const documents = await cursor.toArray();
    const serialized = documents.map(serializeDocument);
    this.#setQueryCacheEntry(
      collection.collectionName,
      cacheKey,
      query,
      serialized,
    );
    return serialized;
  }

  async #findOneById(collection, id) {
    const document = await collection.findOne({ _id: toMongoId(id) });
    return serializeDocument(document);
  }

  async #connectMongo() {
    if (this.#db) {
      return;
    }

    this.#mongoClient = new MongoClient(this.mongoUri);
    await this.#mongoClient.connect();
    this.#db = this.#mongoClient.db(this.dbName);
  }

  #send(socket, payload) {
    socket.send(JSON.stringify(payload));
  }

  #sendError(socket, error, queryId) {
    this.#send(socket, {
      type: "realtime:error",
      error: error instanceof Error ? error.message : String(error),
      ...(queryId ? { queryId } : {}),
    });
  }
}

function normalizeQuery(message) {
  return {
    collection: requiredString(message.collection, "collection"),
    filter: optionalObject(message.filter),
    sort: optionalObject(message.sort),
    limit: Number.isInteger(message.limit) ? message.limit : undefined,
    queryId: String(message.queryId ?? randomUUID()),
  };
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Expected "${field}" to be a non-empty string.`);
  }
  return value;
}

function requiredObject(value, field) {
  if (!isPlainObject(value)) {
    throw new TypeError(`Expected "${field}" to be a plain object.`);
  }
  return deepCopy(value);
}

function optionalObject(value) {
  return isPlainObject(value) ? deepCopy(value) : {};
}

function parsePayload(buffer) {
  const text = Buffer.isBuffer(buffer)
    ? buffer.toString("utf8")
    : String(buffer);
  let payload;

  try {
    payload = JSON.parse(text);
  } catch (_) {}

  if (!isPlainObject(payload)) {
    throw new TypeError("Expected a JSON object payload.");
  }

  return payload;
}

function normalizeMongoUpdate(update) {
  if (isMongoOperatorUpdate(update)) {
    return update;
  }

  return {
    $set: update,
  };
}

function ensureUpdateDoesNotChangeId(update) {
  if (!isPlainObject(update)) {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(update, "_id")) {
    throw new TypeError('Updating "_id" is not supported.');
  }

  if (
    isPlainObject(update.$set) &&
    Object.prototype.hasOwnProperty.call(update.$set, "_id")
  ) {
    throw new TypeError('Updating "_id" is not supported.');
  }
}

function prepareFilter(filter) {
  return transformMongoIds(filter);
}

function prepareDocumentForWrite(document) {
  return transformMongoIds(document);
}

function transformMongoIds(value, path = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => transformMongoIds(entry, path));
  }

  if (!isPlainObject(value)) {
    if (path.endsWith("._id") || path === "_id") {
      return toMongoId(value);
    }
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    next[key] = transformMongoIds(entry, nextPath);
  }
  return next;
}

function toMongoId(value) {
  if (typeof value === "string" && ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  return value;
}

function serializeDocument(document) {
  if (!document) {
    return null;
  }

  return JSON.parse(
    JSON.stringify(document, (_, value) => {
      if (value instanceof ObjectId) {
        return value.toHexString();
      }
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    }),
  );
}

function serializeId(value) {
  if (!value) {
    return null;
  }
  return value instanceof ObjectId ? value.toHexString() : String(value);
}

function toPathname(url) {
  if (!url) {
    return "/";
  }

  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return String(url).split("?")[0] || "/";
  }
}

module.exports = {
  MongoRealTimeServer,
};
