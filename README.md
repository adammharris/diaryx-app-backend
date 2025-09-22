# Diaryx Backend (Elysia + Bun)

A standalone backend for the Diaryx app built with:
- Elysia (HTTP framework)
- Bun (runtime)
- Neon/PostgreSQL (storage)
- Better Auth (session + auth)

This service mirrors the API previously embedded in the Qwik City app and exposes it over a dedicated server.

## Quick Start

Prerequisites:
- Bun installed
- A PostgreSQL database (eg. Neon)
- Required environment variables set (see Configuration)

Install dependencies:
- bun install

Run locally (default port 3000):
- bun run dev

Health check:
- GET http://localhost:3000/health

## Configuration

Set these environment variables in your shell or a `.env` file (if your process manager loads it).

Required:
- DATABASE_URL
  - Your Postgres connection string (eg. Neon).
  - TLS is enabled by default unless you include `sslmode=` in the URL.
- BETTER_AUTH_SECRET
  - Secret used by Better Auth for signing/verifying tokens.

Optional:
- PORT
  - The port to listen on. Defaults to 3000.
- TRUSTED_ORIGINS or AUTH_TRUSTED_ORIGINS
  - Comma or newline-separated list of allowed origins for CORS, eg:
    - TRUSTED_ORIGINS="http://localhost:5173, https://app.diaryx.net"
  - These are merged with a safe default set:
    - http://localhost:3000
    - http://127.0.0.1:3000
    - http://localhost:5173
    - http://127.0.0.1:5173
    - http://localhost:4321
    - http://127.0.0.1:4321
    - https://app.diaryx.net
    - https://adammharris-projects.vercel.app
    - https://*.adammharris-projects.vercel.app
- BETTER_AUTH_URL or AUTH_URL
  - Optional public URL for the auth server if needed by other services

Notes:
- CORS is configured to return:
  - Access-Control-Allow-Origin: <origin> (echoed if allowed)
  - Access-Control-Allow-Credentials: true
  - Access-Control-Allow-Headers: Content-Type, Authorization
  - Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS

## API Overview

All endpoints require a valid Better Auth session cookie unless otherwise noted. The session is created via `/api/auth/*` endpoints (see "Auth" below).

- GET /health
  - Returns: "ok"
  - Public: yes

- ANY /api/auth/*
  - Delegates to Better Auth's handler (sign in/out, session, etc.)
  - Public endpoints vary by Better Auth route

- GET /api/notes
  - Auth required
  - Returns user's notes and visibility terms:
    - 200
      - { notes: Array<{ id, markdown, sourceName, lastModified }>, visibilityTerms: Array<{ term, emails }> }
    - 401 { error: "UNAUTHORIZED" }

- POST /api/notes
  - Auth required
  - Sync notes and update visibility terms
  - Request body:
    - {
        notes: Array<{
          id: string,
          markdown: string,
          sourceName?: string | null,
          lastModified?: number
        }>,
        visibilityTerms: Array<{
          term: string,
          emails: string[]
        }>
      }
  - Returns:
    - 200
      - { notes: Array<{ id, markdown, sourceName, lastModified }>, visibilityTerms: Array<{ term, emails }> }
    - 400 { error: "INVALID_JSON" }
    - 401 { error: "UNAUTHORIZED" }

- DELETE /api/notes/:id
  - Auth required
  - Returns:
    - 200 { status: "deleted" }
    - 400 { error: "MISSING_NOTE_ID" }
    - 401 { error: "UNAUTHORIZED" }

- GET /api/shared-notes
  - Auth required; user's email must be present in the session
  - Returns Diaryx notes that include the current user's email in `visibility_emails` for at least one `visibility` term:
    - 200 { notes: DiaryxNote[] }
    - 400 { error: "EMAIL_REQUIRED" }
    - 401 { error: "UNAUTHORIZED" }

Notes:
- The service stores notes in a `diaryx_note` table and visibility terms in `diaryx_visibility_term`. Tables are auto-created on first use.

## Data Model

Automatically created on first access:

- Table: diaryx_note
  - user_id TEXT NOT NULL
  - id TEXT NOT NULL
  - markdown TEXT NOT NULL
  - source_name TEXT
  - last_modified BIGINT NOT NULL (milliseconds)
  - created_at TIMESTAMPTZ DEFAULT NOW()
  - updated_at TIMESTAMPTZ DEFAULT NOW()
  - PRIMARY KEY (user_id, id)
  - Index: (user_id, updated_at DESC)

- Table: diaryx_visibility_term
  - user_id TEXT NOT NULL
  - term TEXT NOT NULL
  - emails TEXT[] NOT NULL DEFAULT '{}'
  - updated_at TIMESTAMPTZ DEFAULT NOW()
  - PRIMARY KEY (user_id, term)

Upsert policy:
- On note conflict (same user_id + id), updates are applied only if the incoming `last_modified` is greater or equal to the stored value.

## Auth

This backend embeds Better Auth and exposes it at:
- /api/auth/*

Common flows (sign-in, sign-out, get session) are delegated to Better Auth. Refer to Better Auth documentation for exact endpoints and payloads. The frontend should include cookies (credentials: include) when calling backend APIs to persist the session.

## Using With the Frontend (diaryx-app)

The frontend supports targeting this backend via a base URL. Set one of the following environment variables in the frontend:
- DIARYX_API_BASE_URL
- VITE_DIARYX_API_BASE_URL
- VITE_API_BASE_URL
- API_BASE_URL

Example (frontend dev):
- VITE_DIARYX_API_BASE_URL=http://localhost:3000

The frontend will then call:
- GET/POST/DELETE to `${DIARYX_API_BASE_URL}/api/...` with credentials included

For auth, the frontend Better Auth client uses `/api/auth` on the current origin by default. If your frontend is hosted separately from the backend, configure the frontend's auth client base URL (eg. BETTER_AUTH_URL=http://localhost:3000) if needed.

## cURL Examples

Assumes you have a valid auth session cookie named `auth_session` (cookie name may vary depending on Better Auth configuration).

- List notes
  - curl -i --cookie "auth_session=YOUR_COOKIE" http://localhost:3000/api/notes

- Sync notes
  - curl -i -X POST http://localhost:3000/api/notes \
      -H "Content-Type: application/json" \
      --cookie "auth_session=YOUR_COOKIE" \
      --data '{
        "notes": [
          { "id": "n1", "markdown": "---\nvisibility: public\n---\nHello", "sourceName": null, "lastModified": 1700000000000 }
        ],
        "visibilityTerms": [
          { "term": "friends", "emails": ["friend@example.com"] }
        ]
      }'

- Delete a note
  - curl -i -X DELETE --cookie "auth_session=YOUR_COOKIE" http://localhost:3000/api/notes/n1

- Shared notes
  - curl -i --cookie "auth_session=YOUR_COOKIE" http://localhost:3000/api/shared-notes

## Deployment

- Provide the required environment variables
- Run with your process manager of choice, for example:
  - PORT=8080 bun run src/index.ts
- Ensure your deployment platform supports Bun and outbound connections to your database
- Use HTTPS and configure CORS appropriately for your frontend origins

## Notes

- OpenAPI plugin is included for future documentation support. If you add route schemas in Elysia, you can expose and consume a generated spec.
- This backend is tailored for Diaryx and mirrors the API that the Qwik City app previously handled server-side.
