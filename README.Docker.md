### Building and running your application

When you're ready, start your application by running:
`docker compose up --build`.

Your application will be available at http://localhost:3000.

### Deploying your application to the cloud

First, build your image, e.g.: `docker build -t myapp .`.
If your cloud uses a different CPU architecture than your development
machine (e.g., you are on a Mac M1 and your cloud provider is amd64),
you'll want to build the image for that platform, e.g.:
`docker build --platform=linux/amd64 -t myapp .`.

Then, push it to your registry, e.g. `docker push myregistry.com/myapp`.

Consult Docker's [getting started](https://docs.docker.com/go/get-started-sharing/)
docs for more detail on building and pushing.

### References
* [Docker's Node.js guide](https://docs.docker.com/language/nodejs/)

### Migration note: replacing @neondatabase/serverless with pg
If you switch this project from @neondatabase/serverless to pg:
- Add pg to dependencies (not devDependencies), and optionally @types/pg to devDependencies.
  - bun add pg
  - bun add -d @types/pg
- Remove @neondatabase/serverless from your dependencies.
  - bun remove @neondatabase/serverless
- Ensure your DATABASE_URL is a standard Postgres connection string. For managed providers that require TLS (e.g., Neon, Supabase, Render, etc.), append sslmode=require to the URL, for example:
  - postgres://user:pass@host:port/dbname?sslmode=require
- In Docker/Compose, pass DATABASE_URL and BETTER_AUTH_SECRET via environment variables or an .env file.
  - Example: create .env with DATABASE_URL=... and BETTER_AUTH_SECRET=..., then use docker compose up --build
- No native addons are required for pg (pg-native is optional), so the existing Bun-based image works without extra system packages.

After updating dependencies and environment variables, rebuild the image:
- docker compose up --build