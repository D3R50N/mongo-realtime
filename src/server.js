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
const {
  cloneDocuments,
  requiresSubscriptionResync,
  resolveSubscriptionChange,
  sameDocuments,
} = require("./subscription-state");

/**
 * MongoRealTime WebSocket server backed by MongoDB.
 *
 * By default the server reads its configuration from `.env` through `dotenv`.
 * You can either let it create and own its HTTP server, or attach it to an
 * existing HTTP server such as one created for Express.
 */
class MongoRealtime {
  static #instance = null;
  #options;
  #mongoClient;
  #ownsMongoClient;
  #mongoose;
  #mongooseConnection;
  #ownsMongo;
  #db;
  #ownsHttpServer;
  #httpServer;
  #wss;
  #started;
  #authenticate;
  #onConnected;
  #connectedNotified;
  #upgradeAttached;
  #connectionAttached;
  #socketSubscriptions;
  #subscriptions;
  #eventHandlers;
  #queryCache;
  #cacheTtlMs;
  #watchedCollections;
  /**
   * @param {object} [options={}] Server configuration.
   * @param {string} [options.host] Host used when this package owns the HTTP server.
   * @param {number} [options.port] Port used when this package owns the HTTP server.
   * @param {string} [options.path] WebSocket upgrade path. Defaults to `/`.
   * @param {string} [options.mongoUri] MongoDB connection URI.
   * @param {string} [options.dbName] MongoDB database name.
   * @param {number} [options.cacheTtlMs] Cache TTL in milliseconds.
   * @param {(authData:any, request: import('node:http').IncomingMessage)=>boolean|Promise<boolean>} [options.authenticate] Optional connection authenticator.
   * @param {(db: import('mongodb').Db, url?: string)=>void|Promise<void>} [options.onConnected] Callback invoked when connected to the database.
   * @param {import('node:http').Server} [options.server] Existing HTTP server to attach to.
   * @param {import('mongodb').MongoClient} [options.mongoClient] Existing Mongo client to reuse.
   * @param {any} [options.mongoose] Existing Mongoose instance or connection.
   * @param {any} [options.connection] Existing Mongoose connection.
   * @param {import('mongodb').Db} [options.db] Existing Mongo database handle to reuse.
   * @param {typeof import('mongodb').ObjectId} [options.ObjectId] Optional ObjectId class.
   * @param {{info?: Function, warn?: Function}} [options.logger] Logger compatible with `console`.
   */
  constructor(options = {}) {
    const resolved = readEnvironmentOptions(options);

    this.#options = options;
    this.host = resolved.host;
    this.port = resolved.port;
    this.path = resolved.path;
    this.mongoUri = resolved.mongoUri;
    this.dbName = resolved.dbName;
    this.logger = options.logger ?? console;
    this.#authenticate = options.authenticate;
    this.#onConnected = options.onConnected ?? null;
    this.#connectedNotified = false;

    this.#mongoClient = options.mongoClient ?? null;
    this.#ownsMongoClient = !options.mongoClient;
    this.#mongoose = null;
    this.#mongooseConnection = null;
    this.#ownsMongo = false;

    const rawMongoose = options.mongoose ?? options.connection ?? null;
    if (rawMongoose) {
      if (typeof rawMongoose === "object" && rawMongoose !== null) {
        if (rawMongoose.connection) {
          this.#mongoose = rawMongoose;
          this.#mongooseConnection = rawMongoose.connection;
        } else if (
          typeof rawMongoose.openUri === "function" ||
          typeof rawMongoose.asPromise === "function" ||
          rawMongoose.readyState != null
        ) {
          this.#mongooseConnection = rawMongoose;
          this.#mongoose = rawMongoose.base ?? null;
        } else {
          this.#mongoose = rawMongoose;
        }
      } else if (rawMongoose === true) {
        try {
          this.#mongoose = require("mongoose");
          this.#mongooseConnection = this.#mongoose.connection;
        } catch (_) {}
      }
    }

    if (options.db) {
      this.#db = options.db;
    } else if (this.#mongoClient) {
      this.#db = this.#mongoClient.db(this.dbName);
    } else if (
      this.#mongooseConnection &&
      this.#mongooseConnection.readyState === 1 &&
      this.#mongooseConnection.db
    ) {
      this.#db =
        this.dbName &&
        this.#mongooseConnection.name !== this.dbName &&
        typeof this.#mongooseConnection.useDb === "function"
          ? this.#mongooseConnection.useDb(this.dbName).db
          : this.#mongooseConnection.db;
      this.#mongoClient =
        this.#mongooseConnection.getClient?.() ??
        this.#mongooseConnection.client ??
        this.#mongoClient;
      this.#ownsMongoClient = false;
      this.#ownsMongo = false;
    } else {
      this.#db = null;
    }

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
    this.#watchedCollections = new Set();
    this.#cacheTtlMs = Number.isInteger(resolved.cacheTtlMs)
      ? resolved.cacheTtlMs
      : 5 * 60 * 1000;

    MongoRealtime.#instance = this;

    if (
      !this.#ownsHttpServer &&
      (options.host != null || options.port != null)
    ) {
      this.logger.warn?.(
        'MongoRealtime received "host" or "port" with an external HTTP server; those options are ignored.',
      );
    }
  }

  /**
   * Registers a custom event handler for `realtime:emit` messages.
   *
   * @param {string} eventName Custom event name.
   * @param {(payload: any, context: {socket: any, server: MongoRealtime, requestId?: string}) => any | Promise<any>} handler
   * @returns {MongoRealtime}
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
   * @returns {Promise<MongoRealtime>}
   */
  async start() {
    if (this.#started) {
      return this;
    }

    await this.#connectMongo();

    if (!this.#connectionAttached) {
      this.#connectionAttached = true;
      this.#wss.on("connection", (socket) => this.#handleConnection(socket));
    }

    if (!this.#upgradeAttached) {
      this.#upgradeAttached = true;
      this.#httpServer.on("upgrade", async (request, socket, head) => {
        if (toPathname(request.url) !== this.path) {
          return; // just ignore
        }

        if (typeof this.#authenticate === "function") {
          const authData =
            parseAuthHeader(request.headers.auth) ??
            parseTokenFromUrl(request.url);
          let authenticated = false;

          try {
            authenticated = await this.#authenticate(authData, request);
          } catch (error) {
            this.logger.warn?.("Authenticate exception", error);
          }

          if (!authenticated) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
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
        `\x1b[36mMongoRealTime server listening on ws://${this.host}:${this.port}${this.path}\x1b[0m`,
      );
    } else {
      this.logger.info?.(
        `\x1b[36mMongoRealTime server attached to an external HTTP server on path ${this.path}\x1b[0m`,
      );
    }

    return this;
  }

  async #listenInternHandlers() {
    const collections = await this.#db.listCollections().toArray();
    for (let c of collections) {
      this.#watchCollection(c.name);
    }
  }

  #watchCollection(collectionName) {
    if (this.#watchedCollections.has(collectionName) || !this.#db) {
      return;
    }
    this.#watchedCollections.add(collectionName);

    try {
      this.collection(collectionName)
        .watch([], {
          fullDocument: "updateLookup",
        })
        .on("change", (change) => {
          Promise.resolve(this.#handleCacheChange(collectionName, change)).catch(
            () => {},
          );

          const callHandler = (
            type = "change",
            withColl = true,
            docId = "",
          ) => {
            let eventName = `db:${type}`;
            if (withColl) {
              eventName += `:${collectionName}`;
              if (!!docId) eventName += `:${docId}`;
            }

            const handler = this.#eventHandlers.get(eventName);
            try {
              handler?.(change);
              for (let socket of this.#socketSubscriptions.keys()) {
                this.#send(socket, {
                  type: "realtime:db:change",
                  key: eventName,
                  collection: collectionName,
                  docId: serializeId(change.documentKey?._id),
                  operationType: change.operationType,
                  fullDocument: serializeDocument(change.fullDocument),
                });
              }
            } catch (_) {}
          };

          callHandler(change.operationType, true, change.documentKey?._id);
          callHandler("change", true, change.documentKey?._id);
          callHandler(change.operationType);
          callHandler("change");
          callHandler(change.operationType, false);
          callHandler("change", false);
        });
    } catch (_) {}
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

    if (this.#ownsMongo) {
      try {
        if (this.#mongooseConnection?.close) {
          await this.#mongooseConnection.close();
        } else if (this.#mongoose?.disconnect) {
          await this.#mongoose.disconnect();
        }
      } catch (_) {}
    } else if (this.#ownsMongoClient && this.#mongoClient) {
      await this.#mongoClient.close();
    }

    this.#clearQueryCache();
    this.#watchedCollections.clear();
    this.#started = false;
    this.#connectedNotified = false;
    if (MongoRealtime.#instance === this) {
      MongoRealtime.#instance = null;
    }
  }

  /**
   *
   * @param {import('ws').WebSocket} socket
   */
  async #handleConnection(socket) {
    this.#socketSubscriptions.set(socket, new Set());

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
      case "realtime:ping":
        this.#send(socket, {
          type: "realtime:pong",
          timestamp: message.timestamp ?? Date.now(),
        });
        return;
      default:
        throw new Error(`Unsupported message type "${message.type}".`);
    }
  }

  async #subscribe(socket, message) {
    const query = normalizeQuery(message);
    await this.#unsubscribe(query.queryId);

    const collection = this.collection(query.collection);
    const documents = await this.#findDocuments(collection, query, {
      useCache: false,
    });
    const changeStream = collection.watch([], { fullDocument: "updateLookup" });

    const subscription = {
      socket,
      query,
      collection,
      changeStream,
      documents: cloneDocuments(documents),
      pending: Promise.resolve(),
    };

    this.#subscriptions.set(query.queryId, subscription);
    this.#socketSubscriptions.get(socket)?.add(query.queryId);

    changeStream.on("change", (change) => {
      this.#queueSubscriptionChange(query.queryId, change);
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
      { useCache: false },
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
    const objectIdClass = this.#resolveObjectIdClass(collection);
    const document = prepareDocumentForWrite(
      requiredObject(message.document, "document"),
      objectIdClass,
    );
    await collection.insertOne(document);
  }

  async #update(message) {
    const collection = this.collection(
      requiredString(message.collection, "collection"),
    );
    const objectIdClass = this.#resolveObjectIdClass(collection);
    const filter = prepareFilter(optionalObject(message.filter), objectIdClass);
    const update = normalizeMongoUpdate(
      requiredObject(message.update, "update"),
      objectIdClass,
    );

    ensureUpdateDoesNotChangeId(update);
    await collection.updateMany(filter, update);
  }

  async #delete(message) {
    const collection = this.collection(
      requiredString(message.collection, "collection"),
    );
    const objectIdClass = this.#resolveObjectIdClass(collection);
    const filter = prepareFilter(optionalObject(message.filter), objectIdClass);
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

    const { socket, query } = subscription;
    if (socket.readyState !== 1) {
      return;
    }

    if (requiresSubscriptionResync(query)) {
      await this.#resyncSubscription(queryId);
      return;
    }

    const payload = this.#buildChangePayload(subscription, change);
    if (!payload) {
      return;
    }

    this.#send(socket, payload);
  }

  #queueSubscriptionChange(queryId, change) {
    const subscription = this.#subscriptions.get(queryId);
    if (!subscription) {
      return;
    }

    const run = Promise.resolve(subscription.pending)
      .catch(() => {})
      .then(() => this.#forwardChange(queryId, change));

    subscription.pending = run;
    run.catch((error) => {
      this.#sendError(subscription.socket, error, queryId);
    });
  }

  async #resyncSubscription(queryId) {
    const subscription = this.#subscriptions.get(queryId);
    if (!subscription) {
      return;
    }

    const documents = await this.#findDocuments(
      subscription.collection,
      subscription.query,
      {
        useCache: false,
      },
    );

    if (sameDocuments(subscription.documents, documents)) {
      subscription.documents = cloneDocuments(documents);
      return;
    }

    subscription.documents = cloneDocuments(documents);
    this.#send(subscription.socket, {
      type: "realtime:initial",
      collection: subscription.query.collection,
      queryId: subscription.query.queryId,
      documents,
    });
  }

  #buildChangePayload(subscription, change) {
    const result = resolveSubscriptionChange({
      collection: subscription.query.collection,
      query: subscription.query,
      previousDocuments: subscription.documents,
      change: {
        operationType: change.operationType,
        documentId:
          serializeId(change.documentKey?._id) ??
          serializeId(change.fullDocument?._id),
        document: serializeDocument(change.fullDocument),
      },
    });

    subscription.documents = result.documents;
    return result.payload;
  }

  #resolveObjectIdClass(collection) {
    return (
      this.#options?.ObjectId ??
      this.#mongoose?.Types?.ObjectId ??
      this.#mongooseConnection?.base?.Types?.ObjectId ??
      collection?.s?.pkFactory?.createPk?.()?.constructor ??
      this.#db?.client?.options?.pkFactory?.createPk?.()?.constructor ??
      this.#mongoClient?.options?.pkFactory?.createPk?.()?.constructor ??
      ObjectId
    );
  }

  collection(collectionName) {
    return this.#db.collection(collectionName);
  }

  /**
   * Returns the cached collection documents. If not already in cache,
   * queries MongoDB, stores the result in cache, and returns it.
   *
   * @param {string} collectionName Name of the collection.
   * @param {object} [filter={}] Optional filter object.
   * @returns {Array<object>|Promise<Array<object>>}
   */
  get(collectionName, filter = {}) {
    if (typeof collectionName !== "string" || collectionName.trim() === "") {
      throw new TypeError('Expected "collectionName" to be a non-empty string.');
    }

    const colName = collectionName.trim();
    const query = {
      collection: colName,
      filter:
        filter && typeof filter === "object" ? (filter.filter ?? filter) : {},
      sort: filter && typeof filter === "object" && filter.sort ? filter.sort : {},
      limit: filter && typeof filter === "object" ? filter.limit : undefined,
    };

    const cacheKey = this.#getQueryCacheKey(colName, query);
    const collectionCache = this.#queryCache.get(colName);
    const cached = collectionCache?.get(cacheKey);

    if (cached) {
      if (cached.expiresAt == null || cached.expiresAt > Date.now()) {
        return cached.documents.map((doc) => deepCopy(doc));
      }
      this.#deleteQueryCacheEntry(colName, cacheKey);
    }

    return this.#fetchAndCacheCollection(colName, query);
  }

  async #fetchAndCacheCollection(collectionName, query) {
    if (!this.#db) {
      await this.#connectMongo();
    }

    const collection = this.collection(collectionName);
    this.#watchCollection(collectionName);

    return this.#findDocuments(collection, query, { useCache: true });
  }

  /**
   * Returns the cached collection documents from the current server instance.
   *
   * @param {string} collectionName Name of the collection.
   * @param {object} [filter={}] Optional filter object.
   * @returns {Array<object>|Promise<Array<object>>}
   */
  static get(collectionName, filter = {}) {
    if (!MongoRealtime.#instance) {
      throw new Error("No MongoRealtime instance has been created yet.");
    }
    return MongoRealtime.#instance.get(collectionName, filter);
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

  async #findDocuments(collection, query, options = { useCache: false }) {
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

    const objectIdClass = this.#resolveObjectIdClass(collection);
    let cursor = collection.find(prepareFilter(query.filter, objectIdClass));
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

  #decorateDb(url) {
    if (!this.#db) {
      return;
    }

    const connectionUrl =
      this.#mongooseConnection?._connectionString ||
      this.#mongoose?.connection?._connectionString ||
      this.#mongoClient?.s?.url ||
      this.#db?.client?.s?.url;

    const resolvedUrl =
      url ||
      this.#options.mongoUri ||
      connectionUrl ||
      this.mongoUri ||
      this.#db.url ||
      (Array.isArray(this.#mongoClient?.options?.hosts)
        ? this.#mongoClient.options.hosts.map(String).join(",")
        : null);

    if (resolvedUrl) {
      if (!this.mongoUri) {
        this.mongoUri = resolvedUrl;
      }
      try {
        Object.defineProperty(this.#db, "url", {
          value: resolvedUrl,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (_) {
        this.#db.url = resolvedUrl;
      }

      try {
        Object.defineProperty(this.#db, "mongoUri", {
          value: resolvedUrl,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (_) {
        this.#db.mongoUri = resolvedUrl;
      }

      try {
        Object.defineProperty(this.#db, "connectionString", {
          value: resolvedUrl,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch (_) {
        this.#db.connectionString = resolvedUrl;
      }

      if (this.#mongoClient) {
        try {
          this.#mongoClient.url = resolvedUrl;
          this.#mongoClient.mongoUri = resolvedUrl;
          this.#mongoClient.connectionString = resolvedUrl;
        } catch (_) {}
      }
    }

    if (this.#mongoClient && !this.#db.client) {
      try {
        this.#db.client = this.#mongoClient;
      } catch (_) {}
    }

    if (this.#mongooseConnection && !this.#db.connection) {
      try {
        this.#db.connection = this.#mongooseConnection;
      } catch (_) {}
    }

    if (this.#mongoose && !this.#db.mongoose) {
      try {
        this.#db.mongoose = this.#mongoose;
      } catch (_) {}
    }
  }

  async #notifyConnected() {
    if (this.#connectedNotified) {
      return;
    }
    this.#connectedNotified = true;

    const callback = this.#onConnected;
    if (typeof callback === "function") {
      try {
        await callback(this.#db, this.mongoUri);
      } catch (error) {
        this.logger.warn?.("onConnected callback exception", error);
      }
    }
  }

  async #connectMongo() {
    if (this.#db) {
      this.#decorateDb();
      await this.#notifyConnected();
      return;
    }

    let mongoose = this.#mongoose;
    let mongooseConn = this.#mongooseConnection;

    if (!mongoose && !mongooseConn && !this.#mongoClient && !this.#options.db) {
      try {
        const mg = require("mongoose");
        if (
          mg?.connection &&
          (mg.connection.readyState === 1 || mg.connection.readyState === 2)
        ) {
          mongoose = mg;
          mongooseConn = mg.connection;
        } else if (
          mg &&
          this.#options.useMongoose !== false &&
          this.#options.mongoose !== false
        ) {
          mongoose = mg;
          mongooseConn = mg.connection;
        }
      } catch (_) {}
    }

    if (mongooseConn || mongoose) {
      const connOptions = this.dbName ? { dbName: this.dbName } : {};

      if (mongooseConn) {
        if (mongooseConn.readyState === 1 && mongooseConn.db) {
          // Connected already
        } else if (
          mongooseConn.readyState === 2 &&
          typeof mongooseConn.asPromise === "function"
        ) {
          await mongooseConn.asPromise();
        } else if (typeof mongooseConn.openUri === "function") {
          this.#ownsMongo = true;
          await mongooseConn.openUri(this.mongoUri, connOptions);
        } else if (typeof mongoose?.connect === "function") {
          this.#ownsMongo = true;
          await mongoose.connect(this.mongoUri, connOptions);
          mongooseConn = mongoose.connection;
        }
      } else if (typeof mongoose.connect === "function") {
        if (mongoose.connection?.readyState === 1 && mongoose.connection.db) {
          mongooseConn = mongoose.connection;
        } else if (
          mongoose.connection?.readyState === 2 &&
          typeof mongoose.connection.asPromise === "function"
        ) {
          await mongoose.connection.asPromise();
          mongooseConn = mongoose.connection;
        } else {
          this.#ownsMongo = true;
          await mongoose.connect(this.mongoUri, connOptions);
          mongooseConn = mongoose.connection;
        }
      }

      this.#mongoose = mongoose;
      this.#mongooseConnection = mongooseConn;

      if (mongooseConn) {
        this.#db =
          this.dbName &&
          mongooseConn.name !== this.dbName &&
          typeof mongooseConn.useDb === "function"
            ? mongooseConn.useDb(this.dbName).db
            : mongooseConn.db;
        this.#mongoClient =
          mongooseConn.getClient?.() ??
          mongooseConn.client ??
          this.#mongoClient;
        this.#ownsMongoClient = false;
      }
    }

    if (!this.#db) {
      this.#mongoClient = new MongoClient(this.mongoUri);
      await this.#mongoClient.connect();
      this.#ownsMongoClient = true;
      this.#db = this.#mongoClient.db(this.dbName);
    }

    this.#decorateDb();
    await this.#notifyConnected();
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

function parseAuthHeader(headerValue) {
  if (Array.isArray(headerValue)) {
    return parseAuthHeader(headerValue[0]);
  }

  if (typeof headerValue !== "string") {
    return headerValue;
  }

  try {
    return JSON.parse(headerValue);
  } catch (_) {
    return headerValue;
  }
}

function parseTokenFromUrl(url) {
  if (!url) {
    return undefined;
  }

  try {
    const searchParams = new URL(url, "http://localhost:3000").searchParams;
    return (
      searchParams.get("auth-token") ??
      searchParams.get("authToken") ??
      undefined
    );
  } catch {
    const [, rawQuery = ""] = String(url).split("?");
    const searchParams = new URLSearchParams(rawQuery);
    return (
      searchParams.get("auth-token") ??
      searchParams.get("authToken") ??
      undefined
    );
  }
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

const ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

function normalizeMongoUpdate(update, objectIdClass = ObjectId) {
  const normalized = isMongoOperatorUpdate(update) ? update : { $set: update };
  return transformMongoValues(normalized, "", objectIdClass);
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

function prepareFilter(filter, objectIdClass = ObjectId) {
  return transformMongoValues(filter, "", objectIdClass);
}

function prepareDocumentForWrite(document, objectIdClass = ObjectId) {
  return transformMongoValues(document, "", objectIdClass);
}

function transformMongoValues(value, path = "", objectIdClass = ObjectId) {
  if (Array.isArray(value)) {
    return value.map((entry) => transformMongoValues(entry, path, objectIdClass));
  }

  if (!isPlainObject(value)) {
    if (path.endsWith("._id") || path === "_id") {
      return toMongoId(value, objectIdClass);
    }
    if (typeof value === "string" && ISO_DATE_REGEX.test(value)) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    next[key] = transformMongoValues(entry, nextPath, objectIdClass);
  }
  return next;
}

function isObjectId(value) {
  return Boolean(
    value &&
      (value instanceof ObjectId ||
        value._bsontype === "ObjectId" ||
        (typeof value === "object" &&
          typeof value.toHexString === "function" &&
          typeof value.equals === "function")),
  );
}

function toMongoId(value, objectIdClass = ObjectId) {
  if (isObjectId(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    objectIdClass &&
    typeof objectIdClass.isValid === "function" &&
    objectIdClass.isValid(value)
  ) {
    return new objectIdClass(value);
  }
  return value;
}

function serializeDocument(document) {
  if (!document) {
    return null;
  }

  return JSON.parse(
    JSON.stringify(document, (_, value) => {
      if (isObjectId(value)) {
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
  return isObjectId(value) ? value.toHexString() : String(value);
}

function toPathname(url) {
  if (!url) {
    return "/";
  }

  try {
    return new URL(url, "http://localhost:3000").pathname;
  } catch {
    return String(url).split("?")[0] || "/";
  }
}

module.exports = {
  MongoRealtime,
};
