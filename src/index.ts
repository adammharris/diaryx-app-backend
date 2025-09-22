import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { cors } from "@elysiajs/cors";
import { getAuth, getSessionFromRequest } from "./auth";
import {
  listNotesForUser,
  upsertNotesForUser,
  listVisibilityTermsForUser,
  updateVisibilityTermsForUser,
  deleteNoteForUser,
  listNotesSharedWithEmail,
  type DbSharedNote,
} from "./note-storage";

/**
 * Optional CORS middleware setup
 */
import { readAuthConfig } from "./env";

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
  "https://*.adammharris-projects.vercel.app",
];

const CORS_ORIGINS = Array.from(
  new Set([...(trustedOrigins ?? []), ...DEFAULT_CORS_ORIGINS]),
);

const toRegex = (pattern: string) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp("^" + escaped + "$");
};

const isOriginAllowed = (origin: string, patterns: string[]) => {
  return patterns.some((p) => {
    if (p === "*") return true;
    try {
      return toRegex(p).test(origin);
    } catch {
      return false;
    }
  });
};

/**
 * Utility: minimal YAML frontmatter extraction and subset parser
 * We only parse fields needed by shared-notes access check:
 * - visibility: string | string[] (supports inline [a, b] or block "- a")
 * - visibility_emails: Record<string, string[]> (supports inline and block arrays)
 */
const extractFrontmatter = (
  markdown: string,
): { yaml?: string; body: string } => {
  if (!markdown.startsWith("---")) {
    return { body: markdown };
  }
  // Match:
  // ---\n
  //  (yaml...)
  // \n---\n?
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { body: markdown };
  }
  const yaml = match[1] ?? "";
  const body = markdown.slice(match[0].length);
  return { yaml, body };
};

const parseInlineArray = (value: string): string[] => {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

const parseBlockArray = (
  lines: string[],
  startIndex: number,
  indentSpaces: number,
): { items: string[]; end: number } => {
  const items: string[] = [];
  let i = startIndex;
  const re = new RegExp("^" + " ".repeat(indentSpaces) + "-\\s*(.*)$");
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(re);
    if (!m) break;
    const item = (m[1] ?? "").trim();
    if (item) items.push(item);
  }
  return { items, end: i - 1 };
};

type ParsedSubset = {
  visibility?: string | string[];
  visibility_emails?: Record<string, string[]>;
};

const parseYamlSubset = (yaml?: string): ParsedSubset => {
  if (!yaml) return {};
  const lines = yaml.split(/\r?\n/);
  const result: ParsedSubset = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // Top-level key: value
    const top = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const rest = top[2] ?? "";

    // visibility
    if (key === "visibility") {
      if (!rest) {
        // block array following
        const { items, end } = parseBlockArray(lines, i + 1, 2);
        if (items.length) result.visibility = items;
        i = end;
      } else if (rest.trim().startsWith("[")) {
        result.visibility = parseInlineArray(rest);
      } else {
        const value = rest.trim();
        if (value) result.visibility = value;
      }
      continue;
    }

    // visibility_emails
    if (key === "visibility_emails") {
      const map: Record<string, string[]> = {};
      // Either inline (unlikely) or block mapping
      // Expect nested lines with 2 spaces indent: "  term: [a, b]" or "  term:" + 4-spaces array items
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j] ?? "";
        // Stop if new top-level key or fence
        if (/^[A-Za-z0-9_\-]+\s*:/.test(sub) || sub.startsWith("---")) {
          i = j - 1;
          break;
        }
        // Two-space indent mapping
        const mm = sub.match(/^\s{2}([^:\r\n]+)\s*:\s*(.*)$/);
        if (!mm) continue;
        const term = (mm[1] ?? "").trim();
        const after = (mm[2] ?? "").trim();
        if (!term) continue;

        if (after.startsWith("[")) {
          map[term] = parseInlineArray(after);
        } else if (!after) {
          // Expect block array at 4 spaces indent
          const { items, end } = parseBlockArray(lines, j + 1, 4);
          map[term] = items;
          j = end;
        } else {
          // Single scalar as array
          map[term] = [after];
        }
        i = j;
      }
      if (Object.keys(map).length) {
        result.visibility_emails = map;
      }
      continue;
    }
  }
  return result;
};

const randomId = (): string => {
  try {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

type DiaryxNote = {
  id: string;
  body: string;
  metadata: {
    visibility?: string | string[];
    visibility_emails?: Record<string, string[]>;
    [k: string]: unknown;
  };
  frontmatter?: string;
  sourceName?: string;
  autoUpdateTimestamp?: boolean;
  lastModified: number;
};

const parseDiaryxString = (
  fileContents: string,
  options: { id?: string; sourceName?: string } = {},
): { note: DiaryxNote } => {
  const { yaml, body } = extractFrontmatter(fileContents);
  const subset = parseYamlSubset(yaml);
  const note: DiaryxNote = {
    id: options.id ?? randomId(),
    body: (body ?? "").trimStart(),
    metadata: {
      visibility: subset.visibility,
      visibility_emails: subset.visibility_emails,
    },
    frontmatter: yaml?.trim().length ? yaml : undefined,
    sourceName: options.sourceName,
    lastModified: Date.now(),
    autoUpdateTimestamp: false,
  };
  return { note };
};

const toVisibilityArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "string" ? item.trim() : String(item ?? "").trim(),
      )
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  return [];
};

const hasSharedAccess = (note: DiaryxNote, email: string): boolean => {
  const terms = toVisibilityArray(note.metadata.visibility);
  if (!terms.length) return false;
  const map =
    (note.metadata.visibility_emails as Record<string, string[]>) ?? {};
  const lowerEmail = email.trim().toLowerCase();

  // Build case-insensitive term lookup
  const normalizedMap: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(map)) {
    normalizedMap[k.trim().toLowerCase()] = Array.isArray(v) ? v : [];
  }

  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;

    // try exact
    const direct = map[t];
    if (
      Array.isArray(direct) &&
      direct.some((entry) => entry.toLowerCase() === lowerEmail)
    ) {
      return true;
    }

    // try case-insensitive
    const byCase = normalizedMap[t.toLowerCase()];
    if (
      Array.isArray(byCase) &&
      byCase.some((entry) => entry.toLowerCase() === lowerEmail)
    ) {
      return true;
    }
  }
  return false;
};

const json = <T>(set: any, status: number, body: T) => {
  set.status = status;
  set.headers["content-type"] = "application/json; charset=utf-8";
  return body;
};

type SessionUser = { id: string; email?: string | null };

/**
 * Resolves the current user from Better Auth session or returns null.
 */
const getUserFromSession = async (
  req: Request,
): Promise<SessionUser | null> => {
  const session: any = await getSessionFromRequest(req);
  const user: any = session?.user;
  if (user && typeof user.id === "string") {
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
    };
  }
  return null;
};

const PORT = Number(process.env.PORT || 3000);

const app = new Elysia()
  .use(openapi())
  // CORS
  .use(cors())
  // Health
  .get(
    "/",
    () =>
      "<h1>Welcome to the Diaryx API!</h1><p>All systems are working!</p><p>If you want to use the app, please visit <a href='https://app.diaryx.net'>app.diaryx.net</a></p>",
  )
  .get("/health", () => "ok")
  // Auth mounted at root so auth routes are under /api/auth/* (Better Auth handles sub-routes)
  .mount(getAuth().handler)
  // Notes: GET (list notes + visibility terms)
  .get("/api/notes", async ({ request, set }) => {
    try {
      const user = await getUserFromSession(request);
      if (!user) {
        return json(set, 401, { error: "UNAUTHORIZED" });
      }
      const [rows, terms] = await Promise.all([
        listNotesForUser(user.id),
        listVisibilityTermsForUser(user.id),
      ]);
      return json(set, 200, {
        notes: rows.map((row) => ({
          id: row.id,
          markdown: row.markdown,
          sourceName: row.source_name,
          lastModified: Number((row as any).last_modified ?? Date.now()),
        })),
        visibilityTerms: terms,
      });
    } catch (error: any) {
      console.error("Failed to load notes", error);
      return json(set, 500, {
        error: {
          message: error?.message ?? "Unexpected error while loading notes.",
        },
      });
    }
  })
  // Notes: POST (sync notes + update visibility terms)
  .post("/api/notes", async ({ request, set }) => {
    try {
      const user = await getUserFromSession(request);
      if (!user) {
        return json(set, 401, { error: "UNAUTHORIZED" });
      }

      let payload: any;
      try {
        payload = await request.json();
      } catch {
        return json(set, 400, { error: "INVALID_JSON" });
      }

      const notesIn = Array.isArray(payload?.notes) ? payload.notes : [];
      const validNotes = notesIn
        .filter(
          (note: any) =>
            note &&
            typeof note.id === "string" &&
            typeof note.markdown === "string",
        )
        .map((note: any) => ({
          id: String(note.id),
          markdown: String(note.markdown),
          sourceName:
            typeof note.sourceName === "string"
              ? note.sourceName
              : note.sourceName === null
                ? null
                : undefined,
          lastModified:
            typeof note.lastModified === "number"
              ? note.lastModified
              : Number(note.lastModified ?? Date.now()),
        }));

      if (validNotes.length) {
        await upsertNotesForUser(user.id, validNotes);
      }

      const termsIn = Array.isArray(payload?.visibilityTerms)
        ? payload.visibilityTerms
        : [];
      const validTerms = termsIn
        .filter((item: any) => item && typeof item.term === "string")
        .map((item: any) => ({
          term: String(item.term).trim(),
          emails: Array.isArray(item.emails)
            ? item.emails
                .map((email: unknown) =>
                  typeof email === "string" ? email.trim().toLowerCase() : "",
                )
                .filter((email: string) => email.includes("@"))
            : [],
        }))
        .filter(
          (item: { term: string; emails: string[] }) => item.term.length > 0,
        );

      if (validTerms.length) {
        await updateVisibilityTermsForUser(
          user.id,
          Object.fromEntries(
            validTerms.map(
              ({ term, emails }: { term: string; emails: string[] }) => [
                term,
                emails,
              ],
            ),
          ),
        );
      }

      const [rows, terms] = await Promise.all([
        listNotesForUser(user.id),
        listVisibilityTermsForUser(user.id),
      ]);
      return json(set, 200, {
        notes: rows.map((row) => ({
          id: row.id,
          markdown: row.markdown,
          sourceName: row.source_name,
          lastModified: Number((row as any).last_modified ?? Date.now()),
        })),
        visibilityTerms: terms,
      });
    } catch (error: any) {
      console.error("Failed to sync notes", error);
      return json(set, 500, {
        error: {
          message: error?.message ?? "Unexpected error while syncing notes.",
        },
      });
    }
  })
  // Notes: DELETE by id
  .delete("/api/notes/:id", async ({ request, params, set }) => {
    try {
      const user = await getUserFromSession(request);
      if (!user) {
        return json(set, 401, { error: "UNAUTHORIZED" });
      }
      const noteId = (params as any)?.id;
      if (!noteId) {
        return json(set, 400, { error: "MISSING_NOTE_ID" });
      }
      await deleteNoteForUser(user.id, String(noteId));
      return json(set, 200, { status: "deleted" });
    } catch (error: any) {
      console.error("Failed to delete note", error);
      return json(set, 500, {
        error: {
          message: error?.message ?? "Unexpected error while deleting note.",
        },
      });
    }
  })
  // Shared notes visible to current user's email
  .get("/api/shared-notes", async ({ request, set }) => {
    try {
      const user = await getUserFromSession(request);
      if (!user) {
        return json(set, 401, { error: "UNAUTHORIZED" });
      }
      const userEmail =
        typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
      if (!userEmail) {
        return json(set, 400, { error: "EMAIL_REQUIRED" });
      }

      const rows: DbSharedNote[] = await listNotesSharedWithEmail(userEmail);
      const notes: DiaryxNote[] = [];
      const seen = new Set<string>();

      for (const row of rows) {
        try {
          const { note } = parseDiaryxString(row.markdown, {
            id: row.id,
            sourceName: row.source_name ?? undefined,
          });
          const lastModified = Number((row as any).last_modified ?? Date.now());
          note.lastModified = Number.isFinite(lastModified)
            ? lastModified
            : Date.now();
          note.sourceName = row.source_name ?? undefined;

          if (!hasSharedAccess(note, userEmail)) continue;
          if (seen.has(note.id)) continue;

          seen.add(note.id);
          notes.push(note);
        } catch (err) {
          console.warn(`Failed to parse shared note ${row.id}`, err);
        }
      }

      notes.sort((a, b) => {
        const diff = (b.lastModified ?? 0) - (a.lastModified ?? 0);
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      });

      return json(set, 200, { notes });
    } catch (error: any) {
      console.error("Failed to load shared notes", error);
      return json(set, 500, {
        error: {
          message:
            error?.message ?? "Unexpected error while loading shared notes.",
        },
      });
    }
  })
  .listen(PORT);

console.log(
  `🦊 Elysia backend listening on http://localhost:${app.server?.port}`,
);
