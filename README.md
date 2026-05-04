# Mongo Realtime

MongoRealTime exposes MongoDB Change Streams over native WebSockets.\
Clients can subscribe to live updates on query results, perform CRUD operations, and send custom commands to the server.

## 📦 Installation

```bash
npm install mongo-realtime
```

## Quick start

```js
const { MongoRealTimeServer } = require("mongo-realtime");

const server = new MongoRealTimeServer({
  mongoUri: "mongodb://localhost:27017/mydb",
  dbName: "mydb",
});

// Register a handler for custom commands sent with `realtime:emit`.
server.on("calculate", (payload) => {
  return payload.reduce((sum, value) => sum + value, 0);
});

await server.start();
```

## Server configuration

The constructor accepts these options:

- `host` - Host for the built-in HTTP server (`0.0.0.0` by default).
- `port` - Port for the built-in HTTP server (`3000` by default).
- `path` - WebSocket upgrade path (`/` by default).
- `mongoUri` - MongoDB connection URI.
- `dbName` - MongoDB database name.
- `cacheTtlMs` - Query result cache TTL in milliseconds (`300000` by default).
- `authenticate` - Optional async function to validate incoming socket connections.
- `server` - Optional existing HTTP server to attach the WebSocket endpoint.
- `mongoClient` - Optional existing `MongoClient` instance.
- `db` - Optional existing MongoDB `Db` instance.
- `logger` - Optional `{ info?, warn? }` logger object.

When `server` is omitted, the package creates and owns an HTTP server.

## Environment variables

The package can also read configuration from `.env`:

- `HOST`
- `PORT`
- `WS_PATH`
- `MONGODB_URI` or `MONGO_URI`
- `MONGODB_DB_NAME` or `MONGO_DB`
- `CACHE_TTL_MS`
- `CACHE_TTL_SECONDS`

## WebSocket protocol

### Supported message types

From client to server:

- `realtime:subscribe`
- `realtime:unsubscribe`
- `realtime:fetch`
- `realtime:insert`
- `realtime:update`
- `realtime:delete`
- `realtime:emit`

### `realtime:subscribe`

Subscribe to live matching documents and receive an initial result set.

```js
socket.send(
  JSON.stringify({
    type: "realtime:subscribe",
    collection: "users",
    filter: { active: true },
    sort: { createdAt: -1 },
    limit: 50,
    queryId: "my-query-id",
  }),
);
```

The server replies with:

```js
{
  type: 'realtime:initial',
  collection: 'users',
  queryId: 'my-query-id',
  documents: [ ... ],
}
```

Live changes are delivered as separate events:

- `realtime:insert`
- `realtime:update`
- `realtime:delete`

### `realtime:fetch`

Fetch the current document set without keeping a live subscription.

```js
socket.send(
  JSON.stringify({
    type: "realtime:fetch",
    collection: "users",
    filter: { active: true },
    sort: { createdAt: -1 },
    limit: 50,
    queryId: "fetch-1",
  }),
);
```

### `realtime:unsubscribe`

Stop a live subscription by its `queryId`:

```js
socket.send(
  JSON.stringify({
    type: "realtime:unsubscribe",
    queryId: "my-query-id",
  }),
);
```

### `realtime:insert`

Insert a new document into a collection:

```js
socket.send(
  JSON.stringify({
    type: "realtime:insert",
    collection: "users",
    document: { name: "Alice", active: true },
  }),
);
```

### `realtime:update`

Update matching documents in a collection:

```js
socket.send(
  JSON.stringify({
    type: "realtime:update",
    collection: "users",
    filter: { _id: "507f1f77bcf86cd799439011" },
    update: { $set: { active: false } },
  }),
);
```

The server accepts both operator-style updates (`$set`, `$inc`, etc.) and replacement-style updates.

### `realtime:delete`

Delete matching documents from a collection:

```js
socket.send(
  JSON.stringify({
    type: "realtime:delete",
    collection: "users",
    filter: { active: false },
  }),
);
```

### `realtime:emit`

Send a custom command to the server and receive a response.

```js
socket.send(
  JSON.stringify({
    type: "realtime:emit",
    event: "calculate",
    payload: [1, 2, 3],
    requestId: "request-1",
  }),
);
```

Server responses:

```js
{
  type: 'realtime:emit:result',
  event: 'calculate',
  requestId: 'request-1',
  data: 6,
}
```

or:

```js
{
  type: 'realtime:emit:error',
  event: 'calculate',
  requestId: 'request-1',
  error: 'No handler registered for event "calculate".',
}
```

### Server internal events

The server emit internal events that can be listened inside the backend code using `server.on('MY_INTERNAL_EVENT', handler)`.\
`MY_INTERNAL_EVENT` follows these patterns:

- `db:OPERATION_TYPE` : For any operation type on any collection
- `db:OPERATION_TYPE:COLLECTION_NAME` : For a specific operation type on a specific collection
- `db:OPERATION_TYPE:COLLECTION_NAME:DOCUMENT_ID` : For a specific operation type on a specific document

**`OPERATION_TYPE`** can be `insert`, `update`, `delete` or `change` (matches all).\
**`COLLECTION_NAME`** is the name of the collection, e.g. `users`.\
**`DOCUMENT_ID`** is the string representation of the document's `_id`, e.g. `507f1f77bcf86cd799439011`.

Example:

```js
server.on("db:insert:users", (change) => {
  console.log("A new user was inserted:", change.document);
});
server.on("db:update:orders:507f1f77bcf86cd799439011", (change) => {
  console.log(
    "Order 507f1f77bcf86cd799439011 was updated:",
    change.updateDescription,
  );
});
```

It can also be listened inside the client on the event `realtime:db:change`.

```js
/* Client-side
Receives this object
{
  operationType: 'insert' | 'update' | 'delete',
  collection: 'users',
  docId: '507f1f77bcf86cd799439011',
  fullDocument: { ... }, // for insert and update
}*/

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "realtime:db:change") {
    console.log("Database change:", message);
  }
});


```

### Error responses

If a request fails, the server sends:

```js
{
  type: 'realtime:error',
  error: 'Error message',
  queryId?: 'my-query-id',
}
```

## Message payloads from server

Live change messages follow this shape:

```js
{
  type: 'realtime:insert' | 'realtime:update' | 'realtime:delete',
  collection: 'users',
  document: { ... } | null,
  before?: { ... },
  documentId?: '507f1f77bcf86cd799439011',
}
```

## Query filters

Supported filter operators include:

- `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`
- `$in`, `$nin`
- `$exists`
- `$regex`
- `$and`, `$or`, `$nor`

Nested document paths are supported. `_id` strings are automatically converted to `ObjectId` when possible.

## API

### `new MongoRealTimeServer(options)`

Creates a new server instance.

### `server.start()`

Connects to MongoDB, attaches WebSocket handlers, and starts listening if the package owns the HTTP server.

### `server.stop()`

Closes active subscriptions, connected sockets, and owned resources.

### `server.on(eventName, handler)`

Registers a handler for `realtime:emit` messages.

### `server.collection(name)`

Returns a MongoDB collection handle for direct access.

## Authentication

Provide an `authenticate` function to validate WebSocket connections. The incoming payload is read from the `auth` request header and parsed as JSON when possible. If the `auth` header is missing, the server falls back to the `token` query parameter from the WebSocket URL.

Example:

```js
const server = new MongoRealTimeServer({
  authenticate: async (authData, request) => {
    // `authData` is the parsed `auth` header when present,
    // otherwise it falls back to the `token` query parameter.
    const token = new URL(
      request.url,
      "http://localhost:3000",
    ).searchParams.get("token");
    return authData?.session === "ok" || token === "my-auth-token";
  },
});
```

## Example: attach to Express

```js
const http = require("node:http");
const express = require("express");
const { MongoRealTimeServer } = require("mongo-realtime");

const app = express();
const httpServer = http.createServer(app);

const realtimeServer = new MongoRealTimeServer({
  server: httpServer, // needs to be the raw HTTP server, not the Express app
  path: "/", // WebSocket path
  mongoUri: "mongodb://localhost:27017/mydb",
  dbName: "mydb",
});

await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(3000, "0.0.0.0", resolve);
});

await realtimeServer.start(); // start the MongoRealTimeServer after the HTTP server is listening
```

## Notes

- MongoDB must run as a replica set for Change Streams.
- The package now uses native WebSockets (`ws`), no longer Socket.IO.
- Query results are cached for `cacheTtlMs` milliseconds when using `subscribe` or `fetch`.

## Dependencies

- `mongodb`
- `ws`
- `dotenv`

## License

MIT
