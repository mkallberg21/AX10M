/**
 * Per-merchant processor connections, credentials encrypted at rest. This is the
 * persistent source for per-merchant adapter resolution: the webhook router looks up a
 * connection by id (or the processor default), decrypts the config, and builds that
 * merchant's adapter. Plaintext credentials exist only transiently in memory when a
 * webhook is being handled, and are NEVER logged.
 */

import { and, eq } from 'drizzle-orm';
import { merchantConnections } from './schema.js';
import { decryptCredentials, encryptCredentials } from './crypto.js';
import type { Db } from './client.js';

export interface StoredConnection {
  connectionId: string;
  merchantId: string;
  processor: string;
  config: Record<string, unknown>;
  isDefault: boolean;
}

interface ConnRow {
  connectionId: string;
  merchantId: string;
  processor: string;
  credentialsEncrypted: string;
  isDefault: boolean;
}

export class ConnectionRepository {
  constructor(private readonly db: Db, private readonly key: Buffer) {}

  /** Insert or update a connection. `config` is encrypted before it touches the DB. */
  async upsert(conn: {
    connectionId: string;
    merchantId: string;
    processor: string;
    config: Record<string, unknown>;
    isDefault?: boolean;
    createdAt?: string;
  }): Promise<void> {
    const credentialsEncrypted = encryptCredentials(JSON.stringify(conn.config), this.key);
    const isDefault = conn.isDefault ?? false;
    await this.db
      .insert(merchantConnections)
      .values({
        connectionId: conn.connectionId,
        merchantId: conn.merchantId,
        processor: conn.processor,
        credentialsEncrypted,
        isDefault,
        createdAt: conn.createdAt ?? new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: merchantConnections.connectionId,
        set: { merchantId: conn.merchantId, processor: conn.processor, credentialsEncrypted, isDefault },
      });
  }

  async get(connectionId: string): Promise<StoredConnection | undefined> {
    const rows = (await this.db.select().from(merchantConnections).where(eq(merchantConnections.connectionId, connectionId)).limit(1)) as ConnRow[];
    return rows[0] ? this.decrypt(rows[0]) : undefined;
  }

  async defaultFor(processor: string): Promise<StoredConnection | undefined> {
    const rows = (await this.db
      .select()
      .from(merchantConnections)
      .where(and(eq(merchantConnections.processor, processor), eq(merchantConnections.isDefault, true)))
      .limit(1)) as ConnRow[];
    return rows[0] ? this.decrypt(rows[0]) : undefined;
  }

  async list(): Promise<StoredConnection[]> {
    const rows = (await this.db.select().from(merchantConnections)) as ConnRow[];
    return rows.map((r) => this.decrypt(r));
  }

  private decrypt(r: ConnRow): StoredConnection {
    return {
      connectionId: r.connectionId,
      merchantId: r.merchantId,
      processor: r.processor,
      isDefault: r.isDefault,
      config: JSON.parse(decryptCredentials(r.credentialsEncrypted, this.key)) as Record<string, unknown>,
    };
  }
}
