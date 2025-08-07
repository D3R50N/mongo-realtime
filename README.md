# Mongo Realtime

A Node.js package that combines Socket.IO and MongoDB Change Streams to deliver real-time database updates to your WebSocket clients.

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
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const MongoRealtime = require('mongo-realtime');

const app = express();
const server = http.createServer(app);

mongoose.connect('mongodb://localhost:27017/mydb').then((c) => {
    console.log("Connected to db",c.connection.name);
});

MongoRealtime.init({
  connection: mongoose.connection,
  server: server,
  ignore: ["posts"], // ignore 'posts' collection
  onSocket: (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.emit('welcome', { message: 'Connection successful!' });
  },
  offSocket: (socket, reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
  }
});

server.listen(3000, () => {
  console.log('Server started on port 3000');
});
```

## 📋 API

### `MongoRealtime.init(options)`

Initializes the socket system and MongoDB Change Streams.

#### Parameters

\* means required

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.connection` | `mongoose.Connection`* | Active Mongoose connection |
| `options.server` | `http.Server`* | HTTP server to attach Socket.IO |
| `options.onSocket` | `Function` | Callback on socket connection |
| `options.offSocket` | `Function` | Callback on socket disconnection |
| `options.watch` | `Array[String]` | Collections to only watch. Listen to all when is empty |
| `options.ignore` | `Array[String]` | Collections to only ignore. Overrides watch array |

#### Static Properties

- `MongoRealtime.io`: Socket.IO server instance
- `MongoRealtime.connection`: MongoDB connection
- `MongoRealtime.sockets`: Array of connected sockets

## 🎯 Emitted Events

The package automatically emits six types of events for each database change:

### Event Types

| Event | Description | Example |
|-------|-------------|---------|
| `db:change` | All changes | Any collection change |
| `db:{type}` | By operation type | `db:insert`, `db:update`, `db:delete` |
| `db:change:{collection}` | By collection | `db:change:users`, `db:change:posts` |
| `db:{type}:{collection}` | Type + collection | `db:insert:users`, `db:update:posts` |
| `db:change:{collection}:{id}` | Specific document | `db:change:users:507f1f77bcf86cd799439011` |
| `db:{type}:{collection}:{id}` | Type + document | `db:insert:users:507f1f77bcf86cd799439011` |

### Event listeners

You can add serverside listeners to those db events to trigger specific actions on the server:

```js
function sendNotification(change){
  const userId = change.docId; // or change.documentKey._id
  NotificationService.send(userId,"Welcome to DB"); 
}

MongoRealtime.listen("db:insert:users",sendNotification);
```

#### Adding many callback to one event

```js
MongoRealtime.listen("db:insert:users",anotherAction);
MongoRealtime.listen("db:insert:users",anotherAction2);
```

#### Removing event listeners

```js
MongoRealtime.removeListener("db:insert:users",sendNotification); // remove this specific action from this event

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
  connection: connection,
  server: server,
  onSocket: (socket) => {
     socket.on('subscribe:users', () => {
        socket.join('users-room');
    });
  },

});

MongoRealtime.io.to('users-room').emit('custom-event', data);
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

    socket.on('db:change', (change) => {
      console.log('Detected change:', change);
    });

    socket.on('db:insert:users', (change) => {
      console.log('New user:', change.fullDocument);
    });

    const userId = '507f1f77bcf86cd799439011';
    socket.on(`db:update:users:${userId}`, (change) => {
      console.log('Updated user:', change.fullDocument);
    });

    socket.on('db:delete', (change) => {
      console.log('Deleted document:', change.documentKey);
    });
  </script>
</body>
</html>
```

## Error Handling

```javascript
MongoRealtime.init({
  connection: mongoose.connection,
  server: server,
  onSocket: (socket) => {
    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  },
  offSocket: (socket, reason) => {
    if (reason === 'transport error') {
      console.log('Transport error detected');
    }
  }
});
```

## 🔒 Security

### Socket Authentication

```javascript
function authenticateSocket(socket){
    socket.on('authenticate', (token) => {
      if (isValidToken(token)) {
        socket.authenticated = true;
        socket.emit('authenticated');
      } else {
        socket.disconnect();
      }
    });

    socket.use((packet, next) => {
      if (socket.authenticated) {
        next();
      } else {
        next(new Error('Unauthenticated'));
      }
    });
}

MongoRealtime.init({
  connection: mongoose.connection,
  server: server,
  onSocket: authenticateSocket,
  offSocket: (socket, reason) => {
    console.log(`Socket ${socket.id} disconnected: ${reason}`);
  }
});
```

## 📚 Dependencies

- `socket.io`: WebSocket management
- `mongoose`: MongoDB ODM with Change Streams support

## 🐛 Troubleshooting

### MongoDB must be in Replica Set mode

```bash
mongod --replSet rs0

rs.initiate()
```

## 📄 License

MIT

## 🤝 Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request.****
