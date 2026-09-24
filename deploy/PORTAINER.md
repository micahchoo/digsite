# Deploying behind nginx-proxy-manager, through Portainer

For a host where nginx-proxy-manager (NPM) already owns ports 80 and 443,
and stacks are managed in Portainer. digsite publishes no port: NPM
reaches its two containers by name over NPM's own Docker network.

| name | container | port |
| --- | --- | --- |
| `DOMAIN` (the app) | `digsite-web` | 80 |
| `API_DOMAIN` (the API) | `digsite-server` | 8800 |

## 1. Settings

Copy `.env.production.example` to `deploy/.env` and fill it in. It is never
committed. `DOMAIN` and `API_DOMAIN` must both be names you control; the
session cookie reaches the API because both share one registrable domain
(`dig.example.com` and `api.dig.example.com`).

## 2. Build and deploy

```sh
deploy/portainer-deploy.sh
```

It builds three images on this host (the database, the server, the web
app; the web app has `API_DOMAIN` baked in), then creates the Portainer
stack `digsite`, or updates it. The Portainer login is read from
`PORTAINER_ENV` (a file with `PORTAINER_URL`, `PORTAINER_USER`,
`PORTAINER_PASSWORD`). The first start runs the migrations and downloads
CLIP's weights (about 150 MB) when `EMBEDDINGS=on`.

## 3. DNS

Point an A record for each name at this host's public address, and
forward ports 80 and 443 on the router to it, if they are not already.

## 4. NPM: two proxy hosts

In NPM's admin page (port 81), **Hosts › Proxy Hosts › Add Proxy Host**,
twice:

| field | the app | the API |
| --- | --- | --- |
| Domain Names | `DOMAIN` | `API_DOMAIN` |
| Scheme | `http` | `http` |
| Forward Hostname / IP | `digsite-web` | `digsite-server` |
| Forward Port | `80` | `8800` |
| Websockets Support | on | **on** (sheets are live over a socket) |
| Block Common Exploits | on | on |

On the **SSL** tab of each: *Request a new SSL Certificate*, *Force SSL*,
*HTTP/2 Support*, agree to the terms, Save.

On the API's **Advanced** tab:

```nginx
proxy_read_timeout 300s;
```

Uploads need a body limit above NPM's default of 1 MB (at least `110m`,
for `UPLOAD_BATCH_MAX_MB=100`). Add `client_max_body_size 110m;` here
**only if** NPM does not already set one for every host in
`/data/nginx/custom/server_proxy.conf`. Setting it twice makes nginx
refuse the configuration, and NPM reports only "Internal Error" (the real
message is in `docker logs nginx-proxy-manager`: "directive is
duplicate"). On the first deploy host that file already set `5G`.

## 5. First sign-in

Open `https://DOMAIN`. With `SIGNUP=invite`, the first account made and
any address in `OPERATOR_EMAILS` may sign up; everyone else needs a group
invitation. Settings › Accounts (the link under your email, operators
only) gives a person who lost their password a new one.

## 6. Check

```sh
curl -fsS https://API_DOMAIN/readyz
PROD_ORIGIN=https://DOMAIN bun run smoke:prod
```

## Backups

`deploy/backup.sh` and `deploy/restore-drill.sh` work against this stack
with `PG_CONTAINER=digsite-prod-db STORAGE=fs` and `DATA_DIR` set to the
data volume on the host, which only root can read:

```sh
sudo PG_CONTAINER=digsite-prod-db STORAGE=fs \
  DATA_DIR="$(docker volume inspect digsite_digsite-data -f '{{.Mountpoint}}')" \
  deploy/backup.sh ./backups
```

Nothing schedules them yet: add a root cron entry, and copy the backups
off this machine.
