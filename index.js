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
  /** @type {Record<String, [Object]>} */
  static #cache = {};
  static sockets = () => [...this.io.sockets.sockets.values()];

  /**@type {Record<String, {collection:String,filter: (doc:Object)=>Promise<boolean>}>} */
  static #streams = {};

  /** @type {[String]} - All DB collections */
  static collections = [];

  static #safeListStream = true;

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

      throw new Error(`MongoRealtime failed to check "${expr}"`);
    }
  }

  static #log(message, type = 0) {
    const text = `[REALTIME] ${message}`;
    switch (type) {
      case 1:
        console.log(chalk.bold.hex('#11AA60FF')(text));
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

      default:
        console.log(text);
        break;
    }
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
   * @param {[String]} options.autoListStream - Collections to stream automatically. If empty, will stream no collection. If null, will stream all collections.
   * @param {[String]} options.watch - Collections to watch. If empty, will watch all collections
   * @param {[String]} options.ignore - Collections to ignore. Can override `watch`
   * @param {bool} options.safeListStream -  If true(default), declaring an existing streamId will throw an error
   *
   */
  static async init({
    dbUri,
    dbOptions,
    server,
    onDbConnect,
    onDbError,
    authentify,
    onSocket,
    offSocket,
    safeListStream = true,
    autoListStream,
    middlewares = [],
    watch = [],
    ignore = [],
  }) {
    console.clear();
    this.#log(`MongoRealtime version (${this.version})`, 2);
    if (this.io) this.io.close();
    this.#check(() => dbUri);
    this.#check(() => server);

    this.io = new Server(server);
    this.connection.once("open", async () => {
      this.collections = (await this.connection.listCollections()).map(
        (c) => c.name
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
      if (autoListStream == null) collectionsToStream = this.collections;
      else
        collectionsToStream = this.collections.filter((c) =>
          autoListStream.includes(c)
        );
      for (let col of collectionsToStream) this.addListStream(col, col);

      /** Emit streams on change */
      changeStream.on("change", async (change) => {
        const coll = change.ns.coll;

        if (!this.#cache[coll]) {
          this.#cache[coll] = await this.connection.db
            .collection(coll)
            .find({})
            .sort({ _id: -1 })
            .toArray();
        } else
          switch (change.operationType) {
            case "insert":
              this.#cache[coll].unshift(change.fullDocument); // add to top;
              break;

            case "update":
            case "replace":
              this.#cache[coll] = this.#cache[coll].map((doc) =>
                doc._id.toString() === change.documentKey._id.toString()
                  ? change.fullDocument
                  : doc
              );
              break;

            case "delete":
              this.#cache[coll] = this.#cache[coll].filter(
                (doc) =>
                  doc._id.toString() !== change.documentKey._id.toString()
              );
              break;
          }

        Object.entries(this.#streams).forEach(async (e) => {
          const key = e[0];
          const value = e[1];
          if (value.collection != coll) return;
          const filterResults = await Promise.allSettled(
            this.#cache[coll].map((doc) => value.filter(doc))
          );

          const filtered = this.#cache[coll].filter(
            (_, i) => filterResults[i] && filterResults[i].value
          );

          this.io.emit(`db:stream:${key}`, filtered);
          this.notifyListeners(`db:stream:${key}`, filtered);
        });
      });

      /** Emit listen events on change */
      changeStream.on("change", async (change) => {
        const colName = change.ns.coll.toLowerCase();
        change.col = colName;

        const type = change.operationType;
        const id = change.documentKey?._id;

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
      });
    });

    try {
      await mongoose.connect(dbUri, dbOptions);
      this.#log(`Connected to db '${mongoose.connection.name}'`, 1);
      onDbConnect?.call(this, mongoose.connection);
    } catch (error) {
      onDbError?.call(this, error);
      this.#log("Failed to init",4);
      return;
    }

    this.#check(() => mongoose.connection.db, "No database found");

    this.#safeListStream = !!safeListStream;

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
      socket.on("db:stream[register]", async (streamId, registerId) => {
        const stream = this.#streams[streamId];
        if (!stream) return;
        const coll = stream.collection;
        if (!this.#cache[coll]) {
          this.#cache[coll] = await this.connection.db
            .collection(coll)
            .find({})
            .sort({ _id: -1 })
            .toArray();
        }
        const filterResults = await Promise.allSettled(
          this.#cache[coll].map((doc) => stream.filter(doc))
        );

        const filtered = this.#cache[coll].filter(
          (_, i) => filterResults[i] && filterResults[i].value
        );
        this.io.emit(`db:stream[register][${registerId}]`, filtered);
      });

      socket.on("disconnect", (r) => {
        if (offSocket) offSocket(socket, r);
      });

      if (onSocket) onSocket(socket);

    });
    

    this.#log(`Initialized`,1);
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
  static addListStream(streamId, collection, filter) {
    if (!streamId) throw new Error("Stream id is required");
    if (!collection) throw new Error("Collection is required");

    filter ??= (_, __) => true;
    if (this.#safeListStream && this.#streams[streamId]) {
      throw new Error(
        `Stream '${streamId}' already registered or is reserved.`
      );
    }
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
  static removeListStream(streamId) {
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

module.exports = MongoRealtime;
