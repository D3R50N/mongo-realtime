# Mongo Realtime

A Node.js package that combines Socket.IO and MongoDB Change Streams to deliver real-time database updates to your WebSocket clients.

![Banner](logo.png)

## 🚀 Features

- **Real-time updates**: Automatically detects changes in MongoDB and broadcasts them via Socket.IO
- **Granular events**: Emits specific events by operation type, collection, and document
- **Connection management**: Customizable callbacks for socket connections/disconnections
- **TypeScript compatible**: JSDoc annotations for better development experience

## 📦 Installation

```bash
npm install mongo-realtime
```

## Setup

### Prerequisites

- MongoDB running as a replica set (required for Change Streams)
- Node.js HTTP server (See below how to configure an HTTP server with Express)

### Example setup

```javascript
const express = require("express");
const http = require("http");
const MongoRealtime = require("mongo-realtime");

const app = express();
const server = http.createServer(app);

MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  onDbConnect: (conn) => {
    console.log("Connected to db", conn.name);
  },
  onDbError: (err) => {
    console.log(err.message);
  },
  server: server,
  ignore: ["posts"], // ignore 'posts' collection
  onSocket: (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.emit("welcome", { message: "Connection successful!" });
  },
  offSocket: (socket, reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
  },
});

server.listen(3000, () => {
  console.log("Server started on port 3000");
});
```

## 📋 API

### `MongoRealtime.init(options)`

Initializes the socket system and MongoDB Change Streams.

#### Parameters

\* means required

| Parameter                | Type              | Description                                                                      |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| `options.dbUri`          | `String`\*        | Database URI                                                                     |
| `options.dbOptions`      | `Object`          | Mongoose connection options                                                      |
| `options.onDbConnect`    | `Function`        | Callback on successful database connection                                       |
| `options.onDbError`      | `Function`        | Callback on database connection error                                            |
| `options.server`         | `http.Server`\*   | HTTP server to attach Socket.IO                                                  |
| `options.authentify`     | `Function`        | Function to authenticate socket connections. Should return true if authenticated |
| `options.middlewares`    | `Array[Function]` | Array of Socket.IO middlewares                                                   |
| `options.onSocket`       | `Function`        | Callback on socket connection                                                    |
| `options.offSocket`      | `Function`        | Callback on socket disconnection                                                 |
| `options.watch`          | `Array[String]`   | Collections to only watch. Listen to all when is empty                           |
| `options.ignore`         | `Array[String]`   | Collections to only ignore. Overrides watch array                                |
| `options.autoListStream` | `Array[String]`   | Collections to automatically stream to clients. Default is all                   |

#### Static Properties and Methods

- `MongoRealtime.addListStream(streamId, collection, filter)`: Manually add a list stream for a specific collection and filter
- `MongoRealtime.connection`: MongoDB connection
- `MongoRealtime.collections`: Array of database collections
- `MongoRealtime.io`: Socket.IO server instance
- `MongoRealtime.init(options)`: Initialize the package with options
- `MongoRealtime.listen(event, callback)`: Add an event listener for database changes
- `MongoRealtime.notifyListeners(event, data)`: Manually emit an event to all listeners
- `MongoRealtime.removeStream(streamId)`: Remove a previously added stream by id
- `MongoRealtime.removeListener(event, callback)`: Remove a specific event listener or all listeners for an event
- `MongoRealtime.removeAllListeners()`: Remove all event listeners
- `MongoRealtime.sockets()`: Returns an array of connected sockets

## 🎯 Emitted Events

The package automatically emits six types of events for each database change:

### Event Types

| Event                         | Description       | Example                                    |
| ----------------------------- | ----------------- | ------------------------------------------ |
| `db:change`                   | All changes       | Any collection change                      |
| `db:{type}`                   | By operation type | `db:insert`, `db:update`, `db:delete`      |
| `db:change:{collection}`      | By collection     | `db:change:users`, `db:change:posts`       |
| `db:{type}:{collection}`      | Type + collection | `db:insert:users`, `db:update:posts`       |
| `db:change:{collection}:{id}` | Specific document | `db:change:users:507f1f77bcf86cd799439011` |
| `db:{type}:{collection}:{id}` | Type + document   | `db:insert:users:507f1f77bcf86cd799439011` |
| `db:stream:{streamId}`        | By stream         | `db:stream:myStreamId`                     |

### Event listeners

You can add serverside listeners to those db events to trigger specific actions on the server:

```js
function sendNotification(change) {
  const userId = change.docId; // or change.documentKey._id
  NotificationService.send(userId, "Welcome to DB");
}

MongoRealtime.listen("db:insert:users", sendNotification);
```

#### Adding many callback to one event

```js
MongoRealtime.listen("db:insert:users", anotherAction);
MongoRealtime.listen("db:insert:users", anotherAction2);
```

#### Removing event listeners

```js
MongoRealtime.removeListener("db:insert:users", sendNotification); // remove this specific action from this event
MongoRealtime.removeListener("db:insert:users"); // remove all actions from this event
MongoRealtime.removeAllListeners(); // remove all listeners
```

### Event Payload Structure

Each event contains the full MongoDB change object:

```javascript
{
  "_id": {...},
  "col":"users", // same as ns.coll
  "docId":"...", // same as documentKey._id
  "operationType": "insert|update|delete|replace",
  "documentKey": { "_id": "..." },
  "ns": { "db": "mydb", "coll": "users" },
  "fullDocument": {...},
  "fullDocumentBeforeChange": {...}
}
```

## 🔨 Usage Examples

### Server-side - Listening to specific events

```javascript
MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  onSocket: (socket) => {
    socket.on("subscribe:users", () => {
      socket.join("users-room");
    });
  },
});

MongoRealtime.io.to("users-room").emit("custom-event", data);
```

### Client-side - Receiving updates

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="/socket.io/socket.io.js"></script>
  </head>
  <body>
    <script>
      const socket = io();

      socket.on("db:change", (change) => {
        console.log("Detected change:", change);
      });

      socket.on("db:insert:users", (change) => {
        console.log("New user:", change.fullDocument);
      });

      const userId = "507f1f77bcf86cd799439011";
      socket.on(`db:update:users:${userId}`, (change) => {
        console.log("Updated user:", change.fullDocument);
      });

      socket.on("db:delete", (change) => {
        console.log("Deleted document:", change.documentKey);
      });
    </script>
  </body>
</html>
```

## Error Handling

```javascript
MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  onSocket: (socket) => {
    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  },
  offSocket: (socket, reason) => {
    if (reason === "transport error") {
      console.log("Transport error detected");
    }
  },
});
```

## 🔒 Security

### Socket Authentication

You can provide an `authentify` function in the init options to authenticate socket connections.\
The function receives the token (from `socket.handshake.auth.token` or `socket.handshake.headers.authorization`) and the socket object.\
When setted, it rejects connections based on this logic:

- Token not provided -> error `NO_TOKEN_PROVIDED`
- Token invalid or returns `false` -> error `UNAUTHORIZED`
- Any other error -> error `AUTH_ERROR`
- Return `true` to accept the connection

```javascript
function authenticateSocket(token, socket) {
  const verify = AuthService.verifyToken(token);
  if (verify) {
    socket.user = verify.user; // attach user info to socket
    return true; // should return true to accept the connection
  }
  return false;
}

MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  authentify: authenticateSocket,
  middlewares: [
    (socket, next) => {
      console.log(`User is authenticated: ${socket.user.email}`);
      next();
    },
  ],
  offSocket: (socket, reason) => {
    console.log(`Socket ${socket.id} disconnected: ${reason}`);
  },
});
```

### Setup list streams

The server will automatically emit a list of filtered documents from the specified collections after each change.\
Each list stream requires an unique `streamId`, the `collection` name, and an optional `filter` function that returns a boolean or a promise resolving to a boolean.
Clients receive the list on the event `db:stream:{streamId}`.\

On init, when `safeListStream` is `true`(default), two list streams can't have the same `streamId` or else an error will be thrown. This will prevent accidental overrides. You can still remove a stream with `MongoRealtime.removeListStream(streamId)` and add it again or use inside a `try-catch` scope.

```javascript
MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  autoListStream: ["users"], // automatically stream users collection only
});

MongoRealtime.addListStream("users", "users", (doc) => !!doc.email); // will throw an error as streamId 'users' already exists

MongoRealtime.removeListStream("users"); // remove the previous stream
MongoRealtime.addListStream("users", "users", (doc) => !!doc.email); // client can listen to db:stream:users

MongoRealtime.addListStream("usersWithEmail", "users", (doc) => !!doc.email); // client can listen to db:stream:usersWithEmail
```

#### ⚠️ NOTICE

When `autoListStream` is not set, all collections are automatically streamed and WITHOUT any filter.\
That means that if you have a `posts` collection, all documents from this collection will be sent to the clients on each change.\

Also, `safeListStream` is enabled by default. So, you can't add a list stream with id `posts` if `autoListStream` contains `"posts"` or is not set.\

If you want to add a filtered list stream with id `posts`, you must set `autoListStream` to an array NOT containing `"posts"`or call `MongoRealtime.removeListStream("posts")` after initialization.\
Therefore, if you want to add a filtered list stream for all collections, you must set `autoListStream` to an empty array.

To avoid all these issues, you can set `safeListStream` to `false` in the init options but be careful as this will allow you to override existing streams.

```javascript
MongoRealtime.init({
    dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  autoListStream: [], // stream no collection automatically (you can add your own filtered streams later)
});
// or
MongoRealtime.init({
    dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  safeListStream: false, // disable safe mode (you can override existing streams)
  // Still stream all collections automatically but you can override them
}):

MongoRealtime.addListStream("posts", "posts", (doc) => !!doc.title); // client can listen to db:stream:posts
MongoRealtime.addListStream("users", "users", (doc) => !!doc.email); // will not throw an error
```

#### Usecase for id based streams

```javascript
MongoRealtime.init({
  dbUri: "mongodb://localhost:27017/mydb",
  server: server,
  authentify: (token, socket) => {
    try {
      socket.uid = decodeToken(token).uid; // setup user id from token
      return true;
    } catch (error) {
      return false;
    }
  },
  onSocket: (socket) => {
    // setup a personal stream for each connected user
    MongoRealtime.addListStream(
      `userPost:${socket.uid}`,
      "posts",
      (doc) => doc._id == socket.uid
    );
  },
  offSocket: (socket) => {
    // clean up when user disconnects
    MongoRealtime.removeListStream(`userPost:${socket.uid}`);
  },
});

// ...
// or activate stream from a controller or middleware
app.get("/my-posts", (req, res) => {
  const { user } = req;
  try {
    MongoRealtime.addListStream(
      `userPosts:${user._id}`,
      "posts",
      (doc) => doc.authorId === user._id
    );
  } catch (e) {
    // stream already exists
  }

  res.send("Stream activated");
});
```

#### Usecase with async filter

```javascript
// MongoRealtime.init({...});

MongoRealtime.addListStream("authorizedUsers", "users", async (doc) => {
  const isAdmin = await UserService.isAdmin(doc._id);
  return isAdmin && doc.email.endsWith("@mydomain.com");
});

MongoRealtime.addListStream(
  "bestPosts",
  "posts",
  async (doc) => doc.likes > (await PostService.getLikesThreshold())
);
```

## 📚 Dependencies

- `socket.io`: WebSocket management
- `mongoose`: MongoDB ODM with Change Streams support

## 🐛 Troubleshooting

### MongoDB must be in Replica Set mode

To use Change Streams, MongoDB must be running as a replica set. For local development, you can initiate a single-node replica set:

```bash
mongod --replSet rs0

rs.initiate()
```

## 📄 License

MIT

## 🤝 Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request.
