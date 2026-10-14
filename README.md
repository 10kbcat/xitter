# Xitter

A self-hosted backend for the X (Twitter) web client. The server hosts a pinned
build of the official client from your own domain and answers its API from
Postgres, so the real x.com interface runs against your own instance.

The client itself is not in this repository. Each instance downloads its own
copy during setup, and it stays on that machine.

## What works

- Posting, replies, quotes, reposts, likes, bookmarks, pinned posts, @mentions
  and hashtags
- Images, GIFs and video (converted with ffmpeg), long-form articles
- Profiles with all their tabs, editing, follows, followers
- Home timeline: a ranked "For you" and a chronological "Following"
- Notifications with unread counts
- Search with X's operators, trends, Explore
- Blocks, mutes and muted words
- Invite-only sign-up, pride flag badges, organisations with affiliates
- Reporting posts and accounts
- An admin panel at `/admin`: users, standing (restrict, limit, suspend),
  badges, roles, organisations, posts, reports, invites, instance settings,
  feature switches, announcements and an audit log

Not built yet: direct messages, lists, communities, polls, scheduling.

## Running it locally

### What you need

- [Bun](https://bun.sh) 1.4 or newer
- PostgreSQL 14 or newer, with an empty database
- An X account you can sign in to in a browser. Its `auth_token` cookie is used
  once to download the client; nothing about the account is kept.
- Optional: [ffmpeg](https://ffmpeg.org) on the PATH, for video uploads

### Steps

```sh
git clone https://github.com/Xittered/xitter
cd xitter
bun install

# 1. a database (any name; set DATABASE_URL if it isn't the default below)
createdb xitter
export DATABASE_URL=postgres://<user>@localhost:5432/xitter

# 2. download a client build. Take the value of the auth_token cookie from
#    a signed-in x.com tab (DevTools > Application > Cookies > https://x.com).
bun scripts/fetch-client.ts --token <auth_token>

# 3. the first account, made an admin
bun scripts/create-user.ts <name> <password> "<display name>"
bun scripts/make-admin.ts <name>

# 4. run
bun src/server.ts
```

Open `http://localhost:3000` and sign in with the client's own form. The
tables are created on the first start.

More accounts: make invite codes in the admin panel (`/admin` > Invites) or with
`bun scripts/invite.ts`. On the sign-in form, a username that doesn't exist yet
starts sign-up and asks for the code; an invite link (`/signup?code=<code>`)
fills it in.

On Windows, run the commands in Git Bash or set the variables with
`$env:DATABASE_URL = "..."` in PowerShell.

### Keep these private

- The `auth_token` cookie is a live login to your X account. Use it only for
  `fetch-client.ts` and don't share it.
- `client/` holds X's own client code. It is downloaded per instance and must
  not be committed or shared.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://dev@localhost:5432/xitter` | Postgres connection |
| `PORT` | `3000` | Listen port |
| `PUBLIC_ORIGIN` | `http://localhost:$PORT` | Address browsers use to reach the instance |
| `CLIENT_DIR` | `client` | Where the pinned client is stored |
| `MEDIA_DIR` | `media` | Uploaded images and videos |
| `BRANDING_DIR` | `data/branding` | Logos uploaded in the admin panel |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | Video tools |
| `MAX_VIDEO_MB`, `MAX_VIDEO_SECONDS` | `200`, `600` | Starting video limits (changeable in the panel) |
| `SOURCE_URL` | this repository | The source link shown to users |
| `LOG_REQUESTS` | unset | `1` logs every API call, `errors` also prints the client's error reports |
| `JUICEBOX_URL` | `http://localhost:8580` | Private address of the key-backup realm, proxied through `/juicebox/` |
| `CHAT_TOKEN_SECRET` | saved in `data/chat-secrets.json` | Signing secret for chat socket tokens |
| `JUICEBOX_REALM_ID`, `JUICEBOX_TENANT_SECRET` | saved in `data/chat-secrets.json` | Stable realm identity and tenant signing secret |
| `MAX_CHAT_MEDIA_MB` | `200` | Maximum encrypted chat attachment size |

Everything else (name, sign-up mode, features, limits, announcement, rules,
logos) is set in the admin panel.

## Encrypted chat and key backup

Chat encrypts messages and attachments in the browser. Xitter keeps ciphertext,
public keys, membership and event history. Images, videos and files use the same
multipart ciphertext store under `MEDIA_DIR/chat`; downloads require membership.
Requests from accounts you do not follow stay separate until accepted. Group
creation, membership changes, edits, reactions, read receipts and typing use the
pinned client's XChat events.

Passcode recovery requires a Juicebox software realm. `deploy/juicebox` builds
upstream commit `2e485aac584a6c9ada1fb9f156dc4d7cad3ab338` with our Postgres
provider patch. It is also AGPL. The compose stack has its own persistent Postgres
volume and binds the realm to `127.0.0.1:8580`, with no public database port.

Start Xitter once to generate `data/chat-secrets.json`, then prepare the private
configuration and run the stack from the project root:

```sh
bun scripts/prepare-realm.ts deploy/juicebox
docker compose -f deploy/juicebox/compose.yaml -p xitter-juicebox up --build -d
```

`realm.env` is ignored by Git; the preparation script refuses to overwrite an
existing configuration. Keep the realm ID, signing secret and database password
stable. Back up the Postgres volume together with that configuration. Changing
the realm ID or losing its database prevents recovery of existing chat keys.
If Xitter runs inside Docker, connect it to the realm's network and set
`JUICEBOX_URL=http://realm:8580`; browsers continue using Xitter's authenticated
same-origin proxy. The local development realm and the server realm have separate
record stores: starting a server realm does not transfer local backups.

## Development

- `GET /_debug/unknown` lists the client calls no handler answers yet, most
  frequent first. Start there when a screen is empty.
- `scripts/test-*.ts` check each feature end to end against a running server,
  for example `bun scripts/test-posts.ts <user A> <user B> <password>`. Each
  script's first lines give its arguments.
- `bun scripts/test-chat.ts` creates and removes temporary users and checks
  encryption with emusks, access controls, requests, groups, socket delivery,
  attachments and history. `bun test ./scripts/test-chat-token.ts` checks token
  validation without a running server. `bun scripts/test-juicebox.ts` verifies
  realm registration and recovery; run it with `recover` after a realm/database
  restart to check durability (`TEST_JUICEBOX_URL` selects the realm).
- `bun scripts/drive.ts <path> <steps...>` clicks through the real client in
  headless Edge and takes screenshots (uses the browser profile
  `scripts/probe.sh` leaves signed in).

## License

[AGPL-3.0](LICENSE). If you run a modified instance for other people, you must
offer them its source; the signed-out home page links to it (`SOURCE_URL`, or the admin
panel's Settings).
