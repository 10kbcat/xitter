# xitter

A self-hosted backend for the Twitter web client. The server hosts a pinned
build of the official client from your own domain and answers its API from
Postgres.

The client itself is not in this repository. You download it during setup, and
it stays on your machine.

## What works

Sign-in (own login page), home timeline, post page with replies, posting,
replying, likes, reposts (as counters), bookmarks, profiles with posts,
replies and likes tabs, follows and follower lists, blue, gold and grey badges.
Features that are not implemented yet return valid empty answers so the client
does not break.

## Setup

You need [Bun](https://bun.sh) and Postgres.

```sh
bun install

# 1. pin a client build. Needs the auth_token cookie of any Twitter account
#    (or a HAR capture that contains a signed-in x.com/home page).
bun scripts/fetch-client.ts --token <auth_token>
# or: bun scripts/fetch-client.ts --har capture.har

# 2. create an account (badge is optional: blue, business or government)
bun scripts/create-user.ts <name> <password> "<display name>" [badge]

# 3. run
bun src/server.ts
```

Then open `http://localhost:3000/login`.

Only build data is kept from the fetched page: script names, the module loader,
feature switches and page metadata. Nothing about the account the token belongs
to is saved.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://dev@localhost:5432/xitter` | Postgres connection |
| `PORT` | `3000` | Listen port |
| `PUBLIC_ORIGIN` | `http://localhost:$PORT` | Address browsers use to reach the instance |
| `CLIENT_DIR` | `client` | Where the pinned client is stored |
| `LOG_REQUESTS` | unset | `1` logs every API call, `errors` also prints the client's error reports |

The schema is created on startup.

## Development

- `sh scripts/probe.sh [path]` restarts the server, signs in through the login
  form in headless Edge, loads a page and prints the API calls, rendered posts
  and console errors. The screenshot goes to `.probe/shot.png`.
- `bun scripts/js-errors.ts <path without leading slash>` traps the exceptions
  thrown while a page renders (uses the browser profile `probe.sh` left signed in).
- `bun scripts/har-extract.ts` turns raw HAR captures in `har-raw/` into cleaned
  per-request samples in `samples/`, for looking up response formats.
