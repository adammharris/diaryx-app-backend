/**
 * Note storage helpers for the Diaryx backend (Bun/Elysia).
 *
 * This file ports logic from the frontend repo's server-layer and adapts it to
 * the backend environment. It uses a shared Neon connection pool and provides
 * functions for CRUD operations on notes and visibility terms.
 *
 * Tables:
 * - diaryx_note(user_id, id, markdown, source_name, last_modified, created_at, updated_at)
 * - diaryx_visibility_term(user_id, term, emails, updated_at)
 */

import type { Pool } from "pg";
import { getDbPool } from "./auth";

export interface SyncInputNote {
  id: string;
  markdown: string;
  sourceName?: string | null;
  lastModified?: number;
}

export interface DbNote {
  id: string;
  markdown: string;
  source_name: string | null;
  last_modified: string | number;
}

export interface DbSharedNote extends DbNote {
  user_id: string;
}

const ensuredPools = new WeakSet<Pool>();

/**
 * Ensure required tables and indexes exist for the provided pool (singleton per Pool).
 */
const ensureNotesTable = async (): Promise<Pool> => {
  const pool = getDbPool();
  if (ensuredPools.has(pool)) {
    return pool;
  }

  // Notes table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diaryx_note (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      markdown TEXT NOT NULL,
      source_name TEXT,
      last_modified BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    );
  `);

  // Composite index to accelerate queries by user and recency
  await pool.query(
    `CREATE INDEX IF NOT EXISTS diaryx_note_user_updated_idx ON diaryx_note (user_id, updated_at DESC);`,
  );

  // Visibility terms table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diaryx_visibility_term (
      user_id TEXT NOT NULL,
      term TEXT NOT NULL,
      emails TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, term)
    );
  `);

  ensuredPools.add(pool);
  return pool;
};

/**
 * Lists notes for a specific user in descending last_modified order (then updated_at).
 */
export const listNotesForUser = async (userId: string): Promise<DbNote[]> => {
  const pool = await ensureNotesTable();
  const result = await pool.query<DbNote>(
    `SELECT id, markdown, source_name, last_modified
       FROM diaryx_note
      WHERE user_id = $1
      ORDER BY last_modified DESC, updated_at DESC`,
    [userId],
  );
  return result.rows;
};

/**
 * Lists all visibility terms for a specific user.
 */
export const listVisibilityTermsForUser = async (
  userId: string,
): Promise<Array<{ term: string; emails: string[] }>> => {
  const pool = await ensureNotesTable();
  const result = await pool.query<{ term: string; emails: string[] }>(
    `SELECT term, emails
       FROM diaryx_visibility_term
      WHERE user_id = $1
      ORDER BY term ASC`,
    [userId],
  );
  return result.rows;
};

/**
 * Inserts or updates notes for a user.
 * Conflict resolution prefers rows with a newer (greater or equal) last_modified timestamp.
 */
export const upsertNotesForUser = async (
  userId: string,
  notes: SyncInputNote[],
): Promise<void> => {
  if (!notes?.length) return;

  const pool = await ensureNotesTable();

  const queries = notes.map((note) => {
    const lastModified = Number.isFinite(note.lastModified)
      ? Number(note.lastModified)
      : Date.now();
    return pool.query(
      `INSERT INTO diaryx_note (user_id, id, markdown, source_name, last_modified, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, id) DO UPDATE
           SET markdown = EXCLUDED.markdown,
               source_name = EXCLUDED.source_name,
               last_modified = EXCLUDED.last_modified,
               updated_at = NOW()
         WHERE EXCLUDED.last_modified >= diaryx_note.last_modified;`,
      [userId, note.id, note.markdown, note.sourceName ?? null, lastModified],
    );
  });

  await Promise.all(queries);
};

/**
 * Deletes all notes and visibility terms for a user.
 */
export const deleteAllNotesForUser = async (userId: string): Promise<void> => {
  const pool = await ensureNotesTable();
  await pool.query(`DELETE FROM diaryx_note WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM diaryx_visibility_term WHERE user_id = $1`, [
    userId,
  ]);
};

/**
 * Deletes a specific note for a user.
 */
export const deleteNoteForUser = async (
  userId: string,
  noteId: string,
): Promise<void> => {
  const pool = await ensureNotesTable();
  await pool.query(`DELETE FROM diaryx_note WHERE user_id = $1 AND id = $2`, [
    userId,
    noteId,
  ]);
};

/**
 * Replaces all visibility terms for a user with the provided set.
 */
export const updateVisibilityTermsForUser = async (
  userId: string,
  terms: Record<string, string[]>,
): Promise<void> => {
  const pool = await ensureNotesTable();

  // Normalize emails and remove duplicates
  const termEntries = Object.entries(terms).map(([term, emails]) => ({
    term,
    emails: Array.from(
      new Set(
        (emails ?? [])
          .map((email) => (email ?? "").toString().trim().toLowerCase())
          .filter(Boolean),
      ),
    ),
  }));

  // Clear existing and re-insert
  await pool.query(`DELETE FROM diaryx_visibility_term WHERE user_id = $1`, [
    userId,
  ]);
  if (!termEntries.length) return;

  const insertPromises = termEntries.map(({ term, emails }) =>
    pool.query(
      `INSERT INTO diaryx_visibility_term (user_id, term, emails, updated_at)
         VALUES ($1, $2, $3::text[], NOW())`,
      [userId, term, emails],
    ),
  );
  await Promise.all(insertPromises);
};

/**
 * Finds notes which might be shared with the provided email by scanning markdown contents.
 * Caller should verify actual access based on parsed metadata and visibility_emails.
 */
export const listNotesSharedWithEmail = async (
  email: string,
): Promise<DbSharedNote[]> => {
  const pool = await ensureNotesTable();
  const result = await pool.query<DbSharedNote>(
    `SELECT user_id, id, markdown, source_name, last_modified
       FROM diaryx_note
      WHERE markdown ILIKE '%' || $1 || '%'
      ORDER BY updated_at DESC`,
    [email],
  );
  return result.rows;
};
