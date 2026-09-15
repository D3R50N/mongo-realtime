# Changelog

## 3.1.1

- Fixed "Unsupported BSON version" error by dynamically resolving the `ObjectId` class from the host MongoDB driver / collection (`pkFactory`), ensuring compatibility between MongoDB 6.x and 7.x.
- Guaranteed fresh database snapshots on `realtime:subscribe` and `realtime:fetch` by bypassing stale memory cache (`useCache: false`).
- Added multi-BSON version resilience to document and query filter serialization.

## 3.1.0

- Added query caching with TTL and automatic change-driven cache rebuilding.
- Added document serialization improvements for dates and IDs.
- Support for custom event handlers via `realtime:emit`.
