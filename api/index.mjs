import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { cors } from "@elysiajs/cors";
import { Pool } from "@neondatabase/serverless";
import { betterAuth } from "better-auth";

//#region src/env.ts
/**
* Shared environment helpers for the backend (Bun/Elysia).
*
* Provides:
* - read/require helpers for environment variables
* - typed helpers for DATABASE_URL and Auth config
*/
const isNonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
/**
* Reads an environment variable and returns a non-empty string if present.
*/
const readEnvValue = (key) => {
	const v = typeof process !== "undefined" ? process.env?.[key] : void 0;
	return isNonEmpty(v) ? v : void 0;
};
/**
* Requires an environment variable to be present and non-empty, otherwise throws.
*/
const requireEnvValue = (key, errorMessage) => {
	const value = readEnvValue(key);
	if (!isNonEmpty(value)) throw new Error(errorMessage ?? `Missing required env variable: ${key}`);
	return value;
};
/**
* Parses a comma/newline-separated list from an env variable into a string array.
*/
const parseList = (value) => isNonEmpty(value) ? value.split(/[,\n]/g).map((s) => s.trim()).filter(Boolean) : [];
/**
* Returns the DATABASE_URL or throws if missing.
*/
const getDatabaseUrl = () => requireEnvValue("DATABASE_URL");
/**
* Reads auth config from environment without throwing.
*/
const readAuthConfig = () => {
	const secret = readEnvValue("BETTER_AUTH_SECRET");
	const url = readEnvValue("BETTER_AUTH_URL") ?? readEnvValue("AUTH_URL");
	const trustedOrigins$1 = parseList(readEnvValue("TRUSTED_ORIGINS") ?? readEnvValue("AUTH_TRUSTED_ORIGINS"));
	return {
		secret,
		url,
		trustedOrigins: trustedOrigins$1
	};
};

//#endregion
//#region src/auth.ts
/**
* Neon Pool + Better Auth helpers for the backend (Bun/Elysia).
*
* - getDbPool(): returns a cached Neon Pool using DATABASE_URL
* - getAuth(): returns a cached Better Auth instance using Neon Pool
* - getSessionFromRequest(req): convenience to read the session for a request
*/
const poolCache = /* @__PURE__ */ new Map();
const authCache = /* @__PURE__ */ new Map();
const createAuthStub = (message) => ({
	handler: async () => {
		throw new Error(message);
	},
	api: { async getSession() {
		throw new Error(message);
	} }
});
const createPool = (databaseUrl) => new Pool({
	connectionString: databaseUrl,
	ssl: databaseUrl.includes("sslmode=") ? void 0 : { rejectUnauthorized: false }
});
/**
* Returns a cached Neon connection pool for DATABASE_URL.
*/
const getDbPool = () => {
	const databaseUrl = getDatabaseUrl();
	let pool = poolCache.get(databaseUrl);
	if (!pool) {
		pool = createPool(databaseUrl);
		poolCache.set(databaseUrl, pool);
	}
	return pool;
};
/**
* Returns a cached Better Auth instance wired to Neon pool.
* If BETTER_AUTH_SECRET is missing, returns a stub that throws with a clear message.
*/
const getAuth = () => {
	const databaseUrl = getDatabaseUrl();
	const { secret, trustedOrigins: trustedOrigins$1 } = readAuthConfig();
	if (!secret) return createAuthStub("BETTER_AUTH_SECRET environment variable is required for auth");
	const defaultOrigins = ["https://app.diaryx.net", "https://*adammharris-projects.vercel.app"];
	const mergedOrigins = Array.from(new Set([...trustedOrigins$1 ?? [], ...defaultOrigins]));
	const cacheKey = `${databaseUrl}::${secret}`;
	let auth = authCache.get(cacheKey);
	if (!auth) {
		const pool = getDbPool();
		auth = betterAuth({
			database: pool,
			emailAndPassword: { enabled: true },
			secret,
			trustedOrigins: mergedOrigins
		});
		authCache.set(cacheKey, auth);
	}
	return auth;
};
/**
* Attempts to resolve the Better Auth session for the given request.
* Returns null if no valid session is present.
*/
const getSessionFromRequest = async (request) => {
	return await getAuth().api.getSession({
		headers: request.headers,
		asResponse: false
	}) ?? null;
};

//#endregion
//#region src/note-storage.ts
const ensuredPools = /* @__PURE__ */ new WeakSet();
/**
* Ensure required tables and indexes exist for the provided pool (singleton per Pool).
*/
const ensureNotesTable = async () => {
	const pool = getDbPool();
	if (ensuredPools.has(pool)) return pool;
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
	await pool.query(`CREATE INDEX IF NOT EXISTS diaryx_note_user_updated_idx ON diaryx_note (user_id, updated_at DESC);`);
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
const listNotesForUser = async (userId) => {
	return (await (await ensureNotesTable()).query(`SELECT id, markdown, source_name, last_modified
       FROM diaryx_note
      WHERE user_id = $1
      ORDER BY last_modified DESC, updated_at DESC`, [userId])).rows;
};
/**
* Lists all visibility terms for a specific user.
*/
const listVisibilityTermsForUser = async (userId) => {
	return (await (await ensureNotesTable()).query(`SELECT term, emails
       FROM diaryx_visibility_term
      WHERE user_id = $1
      ORDER BY term ASC`, [userId])).rows;
};
/**
* Inserts or updates notes for a user.
* Conflict resolution prefers rows with a newer (greater or equal) last_modified timestamp.
*/
const upsertNotesForUser = async (userId, notes) => {
	if (!notes?.length) return;
	const pool = await ensureNotesTable();
	const queries = notes.map((note) => {
		const lastModified = Number.isFinite(note.lastModified) ? Number(note.lastModified) : Date.now();
		return pool.query(`INSERT INTO diaryx_note (user_id, id, markdown, source_name, last_modified, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, id) DO UPDATE
           SET markdown = EXCLUDED.markdown,
               source_name = EXCLUDED.source_name,
               last_modified = EXCLUDED.last_modified,
               updated_at = NOW()
         WHERE EXCLUDED.last_modified >= diaryx_note.last_modified;`, [
			userId,
			note.id,
			note.markdown,
			note.sourceName ?? null,
			lastModified
		]);
	});
	await Promise.all(queries);
};
/**
* Deletes a specific note for a user.
*/
const deleteNoteForUser = async (userId, noteId) => {
	await (await ensureNotesTable()).query(`DELETE FROM diaryx_note WHERE user_id = $1 AND id = $2`, [userId, noteId]);
};
/**
* Replaces all visibility terms for a user with the provided set.
*/
const updateVisibilityTermsForUser = async (userId, terms) => {
	const pool = await ensureNotesTable();
	const termEntries = Object.entries(terms).map(([term, emails]) => ({
		term,
		emails: Array.from(new Set((emails ?? []).map((email) => (email ?? "").toString().trim().toLowerCase()).filter(Boolean)))
	}));
	await pool.query(`DELETE FROM diaryx_visibility_term WHERE user_id = $1`, [userId]);
	if (!termEntries.length) return;
	const insertPromises = termEntries.map(({ term, emails }) => pool.query(`INSERT INTO diaryx_visibility_term (user_id, term, emails, updated_at)
         VALUES ($1, $2, $3::text[], NOW())`, [
		userId,
		term,
		emails
	]));
	await Promise.all(insertPromises);
};
/**
* Finds notes which might be shared with the provided email by scanning markdown contents.
* Caller should verify actual access based on parsed metadata and visibility_emails.
*/
const listNotesSharedWithEmail = async (email) => {
	return (await (await ensureNotesTable()).query(`SELECT user_id, id, markdown, source_name, last_modified
       FROM diaryx_note
      WHERE markdown ILIKE '%' || $1 || '%'
      ORDER BY updated_at DESC`, [email])).rows;
};

//#endregion
//#region src/index.ts
const { trustedOrigins } = readAuthConfig();
const DEFAULT_CORS_ORIGINS = [
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"http://localhost:4321",
	"http://127.0.0.1:4321",
	"https://app.diaryx.net",
	"https://adammharris-projects.vercel.app",
	"https://*.adammharris-projects.vercel.app"
];
Array.from(new Set([...trustedOrigins ?? [], ...DEFAULT_CORS_ORIGINS]));
/**
* Utility: minimal YAML frontmatter extraction and subset parser
* We only parse fields needed by shared-notes access check:
* - visibility: string | string[] (supports inline [a, b] or block "- a")
* - visibility_emails: Record<string, string[]> (supports inline and block arrays)
*/
const extractFrontmatter = (markdown) => {
	if (!markdown.startsWith("---")) return { body: markdown };
	const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!match) return { body: markdown };
	const yaml = match[1] ?? "";
	const body = markdown.slice(match[0].length);
	return {
		yaml,
		body
	};
};
const parseInlineArray = (value) => {
	const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (!inner.trim()) return [];
	return inner.split(",").map((s) => s.trim()).filter(Boolean);
};
const parseBlockArray = (lines, startIndex, indentSpaces) => {
	const items = [];
	let i = startIndex;
	const re = /* @__PURE__ */ new RegExp("^" + " ".repeat(indentSpaces) + "-\\s*(.*)$");
	for (; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (!m) break;
		const item = (m[1] ?? "").trim();
		if (item) items.push(item);
	}
	return {
		items,
		end: i - 1
	};
};
const parseYamlSubset = (yaml) => {
	if (!yaml) return {};
	const lines = yaml.split(/\r?\n/);
	const result = {};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const top = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
		if (!top) continue;
		const key = top[1];
		const rest = top[2] ?? "";
		if (key === "visibility") {
			if (!rest) {
				const { items, end } = parseBlockArray(lines, i + 1, 2);
				if (items.length) result.visibility = items;
				i = end;
			} else if (rest.trim().startsWith("[")) result.visibility = parseInlineArray(rest);
			else {
				const value = rest.trim();
				if (value) result.visibility = value;
			}
			continue;
		}
		if (key === "visibility_emails") {
			const map = {};
			for (let j = i + 1; j < lines.length; j++) {
				const sub = lines[j] ?? "";
				if (/^[A-Za-z0-9_\-]+\s*:/.test(sub) || sub.startsWith("---")) {
					i = j - 1;
					break;
				}
				const mm = sub.match(/^\s{2}([^:\r\n]+)\s*:\s*(.*)$/);
				if (!mm) continue;
				const term = (mm[1] ?? "").trim();
				const after = (mm[2] ?? "").trim();
				if (!term) continue;
				if (after.startsWith("[")) map[term] = parseInlineArray(after);
				else if (!after) {
					const { items, end } = parseBlockArray(lines, j + 1, 4);
					map[term] = items;
					j = end;
				} else map[term] = [after];
				i = j;
			}
			if (Object.keys(map).length) result.visibility_emails = map;
			continue;
		}
	}
	return result;
};
const randomId = () => {
	try {
		if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
	} catch {}
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
const parseDiaryxString = (fileContents, options = {}) => {
	const { yaml, body } = extractFrontmatter(fileContents);
	const subset = parseYamlSubset(yaml);
	return { note: {
		id: options.id ?? randomId(),
		body: (body ?? "").trimStart(),
		metadata: {
			visibility: subset.visibility,
			visibility_emails: subset.visibility_emails
		},
		frontmatter: yaml?.trim().length ? yaml : void 0,
		sourceName: options.sourceName,
		lastModified: Date.now(),
		autoUpdateTimestamp: false
	} };
};
const toVisibilityArray = (value) => {
	if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item.trim() : String(item ?? "").trim()).filter(Boolean);
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized ? [normalized] : [];
	}
	return [];
};
const hasSharedAccess = (note, email) => {
	const terms = toVisibilityArray(note.metadata.visibility);
	if (!terms.length) return false;
	const map = note.metadata.visibility_emails ?? {};
	const lowerEmail = email.trim().toLowerCase();
	const normalizedMap = {};
	for (const [k, v] of Object.entries(map)) normalizedMap[k.trim().toLowerCase()] = Array.isArray(v) ? v : [];
	for (const term of terms) {
		const t = term.trim();
		if (!t) continue;
		const direct = map[t];
		if (Array.isArray(direct) && direct.some((entry) => entry.toLowerCase() === lowerEmail)) return true;
		const byCase = normalizedMap[t.toLowerCase()];
		if (Array.isArray(byCase) && byCase.some((entry) => entry.toLowerCase() === lowerEmail)) return true;
	}
	return false;
};
const json = (set, status, body) => {
	set.status = status;
	set.headers["content-type"] = "application/json; charset=utf-8";
	return body;
};
/**
* Resolves the current user from Better Auth session or returns null.
*/
const getUserFromSession = async (req) => {
	const user = (await getSessionFromRequest(req))?.user;
	if (user && typeof user.id === "string") return {
		id: user.id,
		email: typeof user.email === "string" ? user.email : null
	};
	return null;
};
const PORT = Number(process.env.PORT || 3e3);
var src_default = new Elysia().use(openapi()).use(cors()).get("/", () => "<h1>Welcome to the Diaryx API!</h1><p>All systems are working!</p><p>If you want to use the app, please visit <a href='https://app.diaryx.net'>app.diaryx.net</a></p>").get("/health", () => "ok").mount(getAuth().handler).get("/api/notes", async ({ request, set }) => {
	try {
		const user = await getUserFromSession(request);
		if (!user) return json(set, 401, { error: "UNAUTHORIZED" });
		const [rows, terms] = await Promise.all([listNotesForUser(user.id), listVisibilityTermsForUser(user.id)]);
		return json(set, 200, {
			notes: rows.map((row) => ({
				id: row.id,
				markdown: row.markdown,
				sourceName: row.source_name,
				lastModified: Number(row.last_modified ?? Date.now())
			})),
			visibilityTerms: terms
		});
	} catch (error) {
		console.error("Failed to load notes", error);
		return json(set, 500, { error: { message: error?.message ?? "Unexpected error while loading notes." } });
	}
}).post("/api/notes", async ({ request, set }) => {
	try {
		const user = await getUserFromSession(request);
		if (!user) return json(set, 401, { error: "UNAUTHORIZED" });
		let payload;
		try {
			payload = await request.json();
		} catch {
			return json(set, 400, { error: "INVALID_JSON" });
		}
		const validNotes = (Array.isArray(payload?.notes) ? payload.notes : []).filter((note) => note && typeof note.id === "string" && typeof note.markdown === "string").map((note) => ({
			id: String(note.id),
			markdown: String(note.markdown),
			sourceName: typeof note.sourceName === "string" ? note.sourceName : note.sourceName === null ? null : void 0,
			lastModified: typeof note.lastModified === "number" ? note.lastModified : Number(note.lastModified ?? Date.now())
		}));
		if (validNotes.length) await upsertNotesForUser(user.id, validNotes);
		const validTerms = (Array.isArray(payload?.visibilityTerms) ? payload.visibilityTerms : []).filter((item) => item && typeof item.term === "string").map((item) => ({
			term: String(item.term).trim(),
			emails: Array.isArray(item.emails) ? item.emails.map((email) => typeof email === "string" ? email.trim().toLowerCase() : "").filter((email) => email.includes("@")) : []
		})).filter((item) => item.term.length > 0);
		if (validTerms.length) await updateVisibilityTermsForUser(user.id, Object.fromEntries(validTerms.map(({ term, emails }) => [term, emails])));
		const [rows, terms] = await Promise.all([listNotesForUser(user.id), listVisibilityTermsForUser(user.id)]);
		return json(set, 200, {
			notes: rows.map((row) => ({
				id: row.id,
				markdown: row.markdown,
				sourceName: row.source_name,
				lastModified: Number(row.last_modified ?? Date.now())
			})),
			visibilityTerms: terms
		});
	} catch (error) {
		console.error("Failed to sync notes", error);
		return json(set, 500, { error: { message: error?.message ?? "Unexpected error while syncing notes." } });
	}
}).delete("/api/notes/:id", async ({ request, params, set }) => {
	try {
		const user = await getUserFromSession(request);
		if (!user) return json(set, 401, { error: "UNAUTHORIZED" });
		const noteId = params?.id;
		if (!noteId) return json(set, 400, { error: "MISSING_NOTE_ID" });
		await deleteNoteForUser(user.id, String(noteId));
		return json(set, 200, { status: "deleted" });
	} catch (error) {
		console.error("Failed to delete note", error);
		return json(set, 500, { error: { message: error?.message ?? "Unexpected error while deleting note." } });
	}
}).get("/api/shared-notes", async ({ request, set }) => {
	try {
		const user = await getUserFromSession(request);
		if (!user) return json(set, 401, { error: "UNAUTHORIZED" });
		const userEmail = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
		if (!userEmail) return json(set, 400, { error: "EMAIL_REQUIRED" });
		const rows = await listNotesSharedWithEmail(userEmail);
		const notes = [];
		const seen = /* @__PURE__ */ new Set();
		for (const row of rows) try {
			const { note } = parseDiaryxString(row.markdown, {
				id: row.id,
				sourceName: row.source_name ?? void 0
			});
			const lastModified = Number(row.last_modified ?? Date.now());
			note.lastModified = Number.isFinite(lastModified) ? lastModified : Date.now();
			note.sourceName = row.source_name ?? void 0;
			if (!hasSharedAccess(note, userEmail)) continue;
			if (seen.has(note.id)) continue;
			seen.add(note.id);
			notes.push(note);
		} catch (err) {
			console.warn(`Failed to parse shared note ${row.id}`, err);
		}
		notes.sort((a, b) => {
			const diff = (b.lastModified ?? 0) - (a.lastModified ?? 0);
			if (diff !== 0) return diff;
			return a.id.localeCompare(b.id);
		});
		return json(set, 200, { notes });
	} catch (error) {
		console.error("Failed to load shared notes", error);
		return json(set, 500, { error: { message: error?.message ?? "Unexpected error while loading shared notes." } });
	}
}).listen(PORT);
console.log(`🦊 Elysia backend listening`);

//#endregion
export { src_default as default };