const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { version } = require("./package.json");
const chalk = require("chalk");

/**
 * @typedef {Object} ChangeStreamDocument
 * @property {"insert"|"update"|"replace"|"delete"|"invalidate"|"drop"|"dropDatabase"|"rename"} operationType
 *   The type of operation that triggered the event.
 *
 * @property {Object} ns
 * @property {string} ns.db - Database name
 * @property {string} ns.coll - Collection name
 *
 * @property {Object} documentKey
 * @property {import("bson").ObjectId|string} documentKey._id - The document’s identifier
 *
 * @property {Object} [fullDocument]
 *   The full document after the change (only present if `fullDocument: "updateLookup"` is enabled).
 *
 * @property {Object} [updateDescription]
 * @property {Object.<string, any>} [updateDescription.updatedFields]
 *   Fields that were updated during an update operation.
 * @property {string[]} [updateDescription.removedFields]
 *   Fields that were removed during an update operation.
 *
 * @property {Object} [rename] - Info about the collection rename (if operationType is "rename").
 *
 * @property {Date} [clusterTime] - Logical timestamp of the event.
 */

class MongoRealtime {
  /** @type {import("socket.io").Server} */ static io;
  /** @type {import("mongoose").Connection} */ static connection =
    mongoose.connection;
  /** @type {Record<String, [(change:ChangeStreamDocument)=>void]>} */ static #listeners =
    {};

  static sockets = () => [...this.io.sockets.sockets.values()];

  /**@type {Record<String, {collection:String,filter: (doc:Object)=>Promise<boolean>}>} */
  static #streams = {};

  /**@type {Record<String, {expiration:Date,result:Record<String,{}> }>} */
  static #data = {};

  /** @type {[String]} - All DB collections */
  static collections = [];

  static #debug = false;

  static version = version;

  static #check(fn, err) {
    const result = fn();
    if (!result) {
      let src = fn.toString().trim();

      let match =
        src.match(/=>\s*([^{};]+)$/) ||
        src.match(/return\s+([^;}]*)/) ||
        src.match(/{([^}]*)}/);

      const expr = err ?? (match ? match[1].trim() : src);

      throw new Error(`MongoRealtime expects "${expr}"`);
    }
  }

  static #log(message, type = 0) {
    const text = `[REALTIME] ${message}`;
    switch (type) {
      case 1:
        console.log(chalk.bold.hex("#11AA60FF")(text));
        break;
      case 2:
        console.log(chalk.bold.bgHex("#257993")(text));
        break;
      case 3:
        console.log(chalk.bold.yellow(text));
        break;
      case 4:
        console.log(chalk.bold.red(text));
        break;

      case 5:
        console.log(chalk.italic(text));
        break;

      default:
        console.log(text);
        break;
    }
  }

  static #debugLog(message) {
    if (this.#debug) this.#log("[DEBUG] " + message, 5);
  }

  /**
   * Initializes the socket system.
   *
   * @param {Object} options
   * @param {String} options.dbUri - Database URI
   * @param {mongoose.ConnectOptions | undefined} options.dbOptions - Database connect options
   * @param {(token:String, socket: import("socket.io").Socket) => boolean | Promise<boolean>} options.authentify - Auth function that should return true if `token` is valid
   * @param {[( socket: import("socket.io").Socket, next: (err?: ExtendedError) => void) => void]} options.middlewares - Register mmiddlewares on incoming socket
   * @param {(conn:mongoose.Connection) => void} options.onDbConnect - Callback triggered when a socket connects
   * @param {(err:Error) => void} options.onDbError - Callback triggered when a socket connects
   * @param {(socket: import("socket.io").Socket) => void} options.onSocket - Callback triggered when a socket connects
   * @param {(socket: import("socket.io").Socket, reason: import("socket.io").DisconnectReason) => void} options.offSocket - Callback triggered when a socket disconnects
   * @param {import("http").Server} options.server - HTTP server to attach Socket.IO to
   * @param {[String]} options.autoStream - Collections to stream automatically. If empty, will stream no collection. If null, will stream all collections.
   * @param {[String]} options.watch - Collections to watch. If empty, will watch all collections
   * @param {[String]} options.ignore - Collections to ignore. Can override `watch`
   * @param {bool} options.debug -  Enable debug mode
   * @param {number} options.cacheDelay - Cache delay in minutes. Put 0 if no cache
   * @param {number} options.allowDbOperations - If true, you can use find and update operations.
   * @param {mongoose} options.mongooseInstance - Running mongoose instance
   *
   *
   */
  static async init({
    dbUri,
    dbOptions,
    server,
    mongooseInstance,
    onDbConnect,
    onDbError,
    authentify,
    onSocket,
    offSocket,
    debug = false,
    autoStream,
    middlewares = [],
    watch = [],
    ignore = [],
    cacheDelay = 5,
    allowDbOperations = true,
  }) {
    this.#log(`MongoRealtime version (${this.version})`, 2);

    if (this.io) this.io.close();
    this.#check(() => dbUri);
    this.#check(() => server);
    this.#debug = debug;

    this.io = new Server(server);
    this.connection.once("open", async () => {
      this.collections = (await this.connection.listCollections()).map(
        (c) => c.name
      );
      this.#debugLog(
        `${this.collections.length} collections found : ${this.collections.join(
          ", "
        )}`
      );

      let pipeline = [];
      if (watch.length !== 0 && ignore.length === 0) {
        pipeline = [{ $match: { "ns.coll": { $in: watch } } }];
      } else if (watch.length === 0 && ignore.length !== 0) {
        pipeline = [{ $match: { "ns.coll": { $nin: ignore } } }];
      } else if (watch.length !== 0 && ignore.length !== 0) {
        pipeline = [
          {
            $match: {
              $and: [
                { "ns.coll": { $in: watch } },
                { "ns.coll": { $nin: ignore } },
              ],
            },
          },
        ];
      }

      const changeStream = this.connection.watch(pipeline, {
        fullDocument: "updateLookup",
        fullDocumentBeforeChange: "whenAvailable",
      });

      /** Setup main streams */
      let collectionsToStream = [];
      if (autoStream == null) collectionsToStream = this.collections;
      else
        collectionsToStream = this.collections.filter((c) =>
          autoStream.includes(c)
        );
      for (let col of collectionsToStream) this.addStream(col, col);
      this.#debugLog(
        `Auto stream on collections  : ${collectionsToStream.join(", ")}`
      );

      /** Emit listen events on change */
      changeStream.on("change", async (change) => {
        const coll = change.ns.coll;
        const colName = coll.toLowerCase();
        const id = change.documentKey?._id.toString();
        const doc = change.fullDocument ?? { _id: id };

        this.#debugLog(`Collection '${colName}' changed`);

        change.col = colName;

        const type = change.operationType;

        const e_change = "db:change";
        const e_change_type = `db:${type}`;
        const e_change_col = `${e_change}:${colName}`;
        const e_change_type_col = `${e_change_type}:${colName}`;

        const events = [
          e_change,
          e_change_type,
          e_change_col,
          e_change_type_col,
        ];

        if (id) {
          change.docId = id;
          const e_change_doc = `${e_change_col}:${id}`;
          const e_change_type_doc = `${e_change_type_col}:${id}`;
          events.push(e_change_doc, e_change_type_doc);
        }
        for (let e of events) {
          this.io.emit(e, change);
          this.notifyListeners(e, change);
        }

        for (const k in this.#streams) {
          const stream = this.#streams[k];
          if (stream.collection != coll) continue;

          Promise.resolve(stream.filter(doc)).then((ok) => {
            if (ok) {
              const data = { added: [], removed: [] };
              if (change.operationType == "delete") data.removed.push(doc);
              else data.added.push(doc);

              this.io.emit(`realtime:${k}`, data);
            }
          });
        }
        for (let k in this.#data) {
          if (!k.startsWith(`${coll}-`) || !this.#data[k].result[id]) continue;
          switch (change.operationType) {
            case "delete":
              delete this.#data[k].result[id];
              break;
            default:
              doc._id = id;
              this.#data[k].result[id] = doc;
          }
        }
      });
    });

    try {
      await mongoose.connect(dbUri, dbOptions);
      this.#log(`Connected to db '${mongoose.connection.name}'`, 1);
      if (mongooseInstance) mongooseInstance.connection = mongoose.connection;
      onDbConnect?.call(this, mongoose.connection);
    } catch (error) {
      onDbError?.call(this, error);
      this.#log("Failed to init", 4);
      return;
    }

    this.#check(() => mongoose.connection.db, "No database found");

    watch = watch.map((s) => s.toLowerCase());
    ignore = ignore.map((s) => s.toLowerCase());

    this.io.use(async (socket, next) => {
      if (!!authentify) {
        try {
          const token =
            socket.handshake.auth.token ||
            socket.handshake.headers.authorization;
          if (!token) return next(new Error("NO_TOKEN_PROVIDED"));

          const authorized = await authentify(token, socket);
          if (authorized === true) return next(); // exactly returns true

          return next(new Error("UNAUTHORIZED"));
        } catch (error) {
          return next(new Error("AUTH_ERROR"));
        }
      } else {
        return next();
      }
    });

    for (let middleware of middlewares) {
      this.io.use(middleware);
    }

    this.io.on("connection", (socket) => {
      socket.emit("version", version);

      socket.on(
        "realtime",
        async ({ streamId, limit, reverse, registerId }) => {
          if (!streamId || !this.#streams[streamId]) return;

          const stream = this.#streams[streamId];
          const coll = stream.collection;
 
          const default_limit = 100;
          limit ??= default_limit;
          try {
            limit = parseInt(limit);
          } catch (_) {
            limit = default_limit;
          }

          reverse = reverse == true;
          registerId ??= "";
          this.#debugLog(
            `Socket '${socket.id}' registred for realtime '${coll}:${registerId}'. Limit ${limit}. Reversed ${reverse}`
          );

          let total;
          const ids = [];

          do {
            total = await this.connection.db
              .collection(coll)
              .estimatedDocumentCount();

            const length = ids.length;
            const range = [length, Math.min(total, length + limit)];
            const now = new Date();

            let cachedKey = `${coll}-${range}`;

            let cachedResult = this.#data[cachedKey];
            if (cachedResult && cachedResult.expiration < now) {
              delete this.#data[cachedKey];
            }

            cachedResult = this.#data[cachedKey];

            const result = cachedResult
              ? Object.values(cachedResult.result)
              : await this.connection.db
                  .collection(coll)
                  .find({
                    _id: {
                      $nin: ids,
                    },
                  })
                  .limit(limit)
                  .sort({ _id: reverse ? -1 : 1 })
                  .toArray();

            ids.push(...result.map((d) => d._id));

            const delayInMin = cacheDelay;
            const expiration = new Date(now.getTime() + delayInMin * 60 * 1000);
            const resultMap = result.reduce((acc, item) => {
              item._id = item._id.toString();
              acc[item._id] = item;
              return acc;
            }, {});

            if (!cachedResult) {
              this.#data[cachedKey] = {
                expiration,
                result: resultMap,
              };
            }

            const filtered = (
              await Promise.all(
                result.map(async (doc) => {
                  try {
                    return {
                      doc,
                      ok: await stream.filter(doc),
                    };
                  } catch (e) {
                    return {
                      doc,
                      ok: false,
                    };
                  }
                })
              )
            )
              .filter((item) => item.ok)
              .map((item) => item.doc);

            const data = {
              added: filtered,
              removed: [],
            };

            socket.emit(`realtime:${streamId}:${registerId}`, data);
          } while (ids.length < total);
        }
      );
      if (allowDbOperations) {
        socket.on("realtime:count", async ({ coll, query }, ack) => {
          if (!coll) return ack(0);
          query ??= {};
          const c = this.connection.db.collection(coll);
          const hasQuery = notEmpty(query);
          const count = hasQuery
            ? await c.countDocuments(query)
            : await c.estimatedDocumentCount();
          ack(count);
        });

        socket.on(
          "realtime:find",
          async (
            { coll, query, limit, sortBy, project, one, skip, id },
            ack
          ) => {
            if (!coll) return ack(null);
            const c = this.connection.db.collection(coll);

            if (id) {
              ack(await c.findOne({ _id: toObjectId(id) }));
              return;
            }

            query ??= {};
            one = one == true;

            if (query["_id"]) {
              query["_id"] = toObjectId(query["_id"]);
            }

            const options = {
              sort: sortBy,
              projection: project,
              skip: skip,
              limit: limit,
            };

            if (one) {
              ack(await c.findOne(query, options));
              return;
            }

            let cursor = c.find(query, options);
            ack(await cursor.toArray());
          }
        );

        socket.on(
          "realtime:update",
          async (
            { coll, query, limit, sortBy, project, one, skip, id, update },
            ack
          ) => {
            if (!coll || !notEmpty(update)) return ack(0);
            const c = this.connection.db.collection(coll);

            if (id) {
              ack(
                (await c.updateOne({ _id: toObjectId(id) }, update))
                  .modifiedCount
              );
              return;
            }

            query ??= {};
            one = one == true;

            if (query["_id"]) {
              query["_id"] = toObjectId(query["_id"]);
            }

            const options = {
              sort: sortBy,
              projection: project,
              skip: skip,
              limit: limit,
            };

            if (one) {
              ack((await c.updateOne(query, update, options)).modifiedCount);
              return;
            }

            let cursor = await c.updateMany(query, update, options);
            ack(cursor.modifiedCount);
          }
        );
      }

      socket.on("disconnect", (r) => {
        if (offSocket) offSocket(socket, r);
      });

      if (onSocket) onSocket(socket);
    });

    this.#log(`Initialized`, 1);
  }

  /**
   * Notify all event listeners
   *
   * @param {String} e - Name of the event
   * @param {ChangeStreamDocument} change - Change Stream
   */
  static notifyListeners(e, change) {
    if (this.#listeners[e]) {
      for (let c of this.#listeners[e]) {
        c(change);
      }
    }
  }

  /**
   * Subscribe to an event
   *
   * @param {String} key - Name of the event
   * @param {(change:ChangeStreamDocument)=>void} cb - Callback
   */
  static listen(key, cb) {
    if (!this.#listeners[key]) this.#listeners[key] = [];
    this.#listeners[key].push(cb);
  }

  /**
   *
   * @param {String} streamId - StreamId of the list stream
   * @param {String} collection - Name of the collection to stream
   * @param { (doc:Object )=>Promise<boolean>} filter - Collection filter
   *
   * Register a new list stream to listen
   */
  static addStream(streamId, collection, filter) {
    if (!streamId) throw new Error("Stream id is required");
    if (!collection) throw new Error("Collection is required");
    if (this.#streams[streamId] && this.collections.includes(streamId))
      throw new Error(`streamId '${streamId}' cannot be a collection`);

    filter ??= (_, __) => true;

    this.#streams[streamId] = {
      collection,
      filter,
    };
  }

  /**
   * @param {String} streamId - StreamId of the stream
   *
   * Delete a registered stream
   */
  static removeStream(streamId) {
    delete this.#streams[streamId];
  }

  /**
   * Remove one or all listeners of an event
   *
   * @param {String} key - Name of the event
   * @param {(change:ChangeStreamDocument)=>void} cb - Callback
   */
  static removeListener(key, cb) {
    if (cb) this.#listeners[key] = this.#listeners[key].filter((c) => c != cb);
    else this.#listeners[key] = [];
  }

  /**
   * Unsubscribe to all events
   */
  static removeAllListeners() {
    this.#listeners = {};
  }
}

// utils
function notEmpty(obj) {
  obj ??= {};
  return Object.keys(obj).length > 0;
}
/** @param {String} id  */
function toObjectId(id) {
  if (typeof id != "string") return id;
  try {
    return mongoose.Types.ObjectId.createFromHexString(id);
  } catch (_) {
    return new mongoose.Types.ObjectId(id); //use deprecated if fail
  }
}

module.exports = MongoRealtime;
