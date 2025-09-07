const { Server } = require("socket.io");

class MongoRealtime {
  /** @type {import("socket.io").Server} */ static io;
  /** @type {import("mongoose").Connection} */ static connection;
  /** @type {[import("socket.io").Socket]} */ static sockets = [];
  /** @type {Record<String, [(change:ChangeStreamDocument)=>void]>} */ static #listeners =
    {};

  /**
   * Initializes the socket system.
   *
   * @param {Object} options
   * @param {import("mongoose").Connection} options.connection - Active Mongoose connection
   * @param {(token:String, socket: import("socket.io").Socket) => boolean | Promise<boolean>} options.authentify - Auth function that should return true if `token` is valid
   * @param {[( socket: import("socket.io").Socket, next: (err?: ExtendedError) => void) => void]} options.middlewares - Register mmiddlewares on incoming socket
   * @param {(socket: import("socket.io").Socket) => void} options.onSocket - Callback triggered when a socket connects
   * @param {(socket: import("socket.io").Socket, reason: import("socket.io").DisconnectReason) => void} options.offSocket - Callback triggered when a socket disconnects
   * @param {import("http").Server} options.server - HTTP server to attach Socket.IO to
   * @param {[String]} options.watch - Collections to watch. If empty, will watch all collections
   * @param {[String]} options.ignore - Collections to ignore. Can override `watch`
   *
   */
  static init({
    connection,
    server,
    authentify,
    middlewares=[],
    onSocket,
    offSocket,
    watch = [],
    ignore = [],
  }) {
    if (this.io)
      this.io.close(() => {
        this.sockets = [];
      });
    this.io = new Server(server);
    this.connection = connection;

    watch = watch.map((s) => s.toLowerCase());
    ignore = ignore.map((s) => s.toLowerCase());

    this.io.use(async (socket, next) => {
      if (!!authentify) {
        try {
          const token = socket.handshake.auth.token;
          if (!token) return next(new Error("No token provided"));

          const authorized =await authentify(token, socket);
          if (authorized===true) return next(); // exactly returns true

          return next(new Error("Unauthorized"));
        } catch (error) {
          return next(new Error("Authentication error"));
        }
      } else {
        return next();
      }
      
    });

    for (let middleware of middlewares) {
      this.io.use(middleware);
    }

    this.io.on("connection", (socket) => {
      this.sockets = [...this.io.sockets.sockets.values()];
      if (onSocket) onSocket(socket);

      socket.on("disconnect", (r) => {
        this.sockets = [...this.io.sockets.sockets.values()];
        if (offSocket) offSocket(socket, r);
      });
    });

    connection.once("open", () => {
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

      const changeStream = connection.watch(pipeline, {
        fullDocument: "updateLookup",
        fullDocumentBeforeChange: "whenAvailable",
      });

      changeStream.on("change", (change) => {
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
