import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db, IDatabaseConnection } from './database';
import { logger } from './logger';

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  filePath: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

const getCurrentDir = () => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  }
};

export class SchemaMigrator {
  private migrationsDir: string;
  private database: IDatabaseConnection;

  constructor(migrationsDir?: string, database: IDatabaseConnection = db) {
    if (migrationsDir) {
      this.migrationsDir = migrationsDir;
    } else {
      const currentDir = getCurrentDir();
      const candidates = [
        path.resolve(process.cwd(), 'server/migrations'),
        path.resolve(process.cwd(), 'migrations'),
        path.resolve(currentDir, '../../migrations'),
        path.resolve(currentDir, '../migrations'),
      ];
      this.migrationsDir = candidates.find(c => fs.existsSync(c)) || candidates[0];
    }
    this.database = database;
  }


  public getMigrationFiles(): MigrationFile[] {
    if (!fs.existsSync(this.migrationsDir)) {
      throw new Error(`Migrations directory does not exist: ${this.migrationsDir}`);
    }

    const files = fs.readdirSync(this.migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    return files.map(filename => {
      const filePath = path.join(this.migrationsDir, filename);
      // Strip a leading UTF-8 BOM (U+FEFF). Editors on Windows may save
      // migration files BOM-prefixed; PostgreSQL rejects the BOM with
      // `syntax error at or near ""` because it is not valid SQL leading
      // whitespace. Stripping it here protects every migration at the single
      // point where SQL is loaded, without altering any migration's content.
      const sql = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
      const version = filename.split('_')[0] || filename;
      const name = filename.replace(/\.sql$/, '');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      return {
        version,
        name,
        filename,
        filePath,
        sql,
        checksum
      };
    });
  }

  public async initMigrationTable(): Promise<void> {
    const ddl = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        version VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;
    await this.database.query(ddl);
  }

  public async getAppliedMigrations(): Promise<AppliedMigration[]> {
    try {
      await this.initMigrationTable();
      const result = await this.database.query<AppliedMigration>(
        'SELECT version, name, checksum, applied_at AS "appliedAt" FROM schema_migrations ORDER BY version ASC'
      );
      return result.rows || [];
    } catch (err) {
      logger.warn('Failed to fetch applied migrations, defaulting to empty list', {}, err as Error);
      return [];
    }
  }

  public async getPendingMigrations(): Promise<MigrationFile[]> {
    const allFiles = this.getMigrationFiles();
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map(a => a.version));

    return allFiles.filter(f => !appliedVersions.has(f.version));
  }

  public async runMigrations(): Promise<{ applied: string[]; total: number }> {
    const pending = await this.getPendingMigrations();
    logger.info(`Found ${pending.length} pending database migration(s)`);

    const appliedNames: string[] = [];

    for (const migration of pending) {
      logger.info(`Applying migration: ${migration.filename}`, { version: migration.version });
      
      // Execute migration SQL
      await this.database.query(migration.sql);

      // Record in schema_migrations
      await this.database.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum]
      );

      appliedNames.push(migration.filename);
      logger.info(`Successfully applied migration: ${migration.filename}`);
    }

    return {
      applied: appliedNames,
      total: appliedNames.length
    };
  }

  public verifyIntegrity(): { total: number; valid: boolean; files: string[] } {
    const files = this.getMigrationFiles();
    if (files.length === 0) {
      return { total: 0, valid: false, files: [] };
    }

    for (const file of files) {
      if (!file.sql || file.sql.trim().length === 0) {
        throw new Error(`Migration file ${file.filename} is empty`);
      }
      if (!file.version || !/^\d+$/.test(file.version)) {
        throw new Error(`Migration file ${file.filename} does not have a valid numeric prefix version`);
      }
    }

    return {
      total: files.length,
      valid: true,
      files: files.map(f => f.filename)
    };
  }
}

export const migrator = new SchemaMigrator();
