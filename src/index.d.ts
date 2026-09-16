import type { Db, Collection, Document } from 'mongodb';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';

export interface MongoRealtimeGetOptions {
  /**
   * Maximum number of documents to return.
   */
  limit?: number | string;

  /**
   * Sort order specification (e.g. `{ createdAt: -1 }`).
   */
  sort?: Record<string, 1 | -1 | number | string>;
}

export interface MongoRealtimeOptions {
  server?: HttpServer | HttpsServer;
  port?: number;
  host?: string;
  url?: string;
  db?: Db | string;
  connection?: any;
  mongoose?: any;
  onConnected?: (db: Db, url: string) => void | Promise<void>;
  authenticate?: (authData: any, request: any) => boolean | Promise<boolean>;
  cacheTtlMs?: number;
}

export class MongoRealtime {
  constructor(options?: MongoRealtimeOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  collection(collectionName: string): Collection;
  get(
    collectionName: string,
    filter?: Document,
    options?: MongoRealtimeGetOptions
  ): Array<Document> | Promise<Array<Document>>;
  static get(
    collectionName: string,
    filter?: Document,
    options?: MongoRealtimeGetOptions
  ): Array<Document> | Promise<Array<Document>>;
}

export function get(
  collectionName: string,
  filter?: Document,
  options?: MongoRealtimeGetOptions
): Array<Document> | Promise<Array<Document>>;
