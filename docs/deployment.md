# Deployment

Pstryk runs as a Docker container behind Caddy, which handles HTTPS. Data is stored in MongoDB Atlas.

## Requirements

- A VPS with Docker and the Compose plugin. 1 vCPU, 1 GB RAM and a few GB of disk is plenty.
- A domain or subdomain whose DNS A/AAAA record points at the VPS.
- Ports 80 and 443 open. Port 80 is needed for Let's Encrypt and redirects to HTTPS.
- A MongoDB Atlas cluster. The free M0 tier is enough.
- An MQTT broker (see [Choosing where the broker lives](#choosing-where-the-broker-lives)).

## 1. MongoDB Atlas

1. **Database Access**: create a user, e.g. `pstryk`, with *Read and write to any database*. You can
   narrow this to the `pstryk` database.
2. **Network Access**: add the VPS's public IP address. Avoid `0.0.0.0/0`.
3. **Connect → Drivers**: copy the `mongodb+srv://…` string and insert the password.

Pstryk creates its collections and indexes on startup: `hooks` with a unique name index, and `calls`
with a TTL index that deletes call history after `CALL_LOG_DAYS`.

## 2. First install on the VPS

```sh
git clone https://github.com/grzegorz-grzeda/pstryk.git ~/pstryk
cd ~/pstryk
cp .env.example .env
nano .env        # PSTRYK_DOMAIN, PUBLIC_URL, MONGODB_URI, MQTT_*, ADMIN_PASSWORD
docker compose pull
docker compose up -d
docker compose logs -f pstryk
```

`docker compose pull` fetches the image that CI built (`ghcr.io/grzegorz-grzeda/pstryk:latest`). To
build on the server instead, run `docker compose up -d --build`.

Then open `https://<your-domain>/admin`.

> **Image visibility:** container packages on GHCR start out private, even for a public repository.
> After the first CI run, open the package (GitHub profile → Packages → pstryk → Package settings) and
> change its visibility to **Public**. Otherwise, run `docker login ghcr.io` on the VPS with a
> personal access token that has the `read:packages` scope.

## 3. Automatic deploys (CD)

The [CI/CD workflow](../.github/workflows/ci.yml) deploys every push to `main` once it's configured:

```
push to main → lint & test → build image → push to ghcr.io (latest + sha-xxxxxxx) → SSH to VPS → pull & restart → /healthz check
```

Pull requests run lint, tests and an image build, but never deploy.

### Set up a deploy user and key

On the VPS:

```sh
sudo adduser --disabled-password deploy
sudo usermod -aG docker deploy
sudo -iu deploy git clone https://github.com/grzegorz-grzeda/pstryk.git ~deploy/pstryk
# then create ~deploy/pstryk/.env as in step 2
```

On your own machine:

```sh
ssh-keygen -t ed25519 -f pstryk_deploy -N "" -C "github-actions-deploy"
ssh-copy-id -i pstryk_deploy.pub deploy@<vps>      # or append the .pub to ~deploy/.ssh/authorized_keys
ssh-keyscan -p 22 <vps> > known_hosts
```

> Membership of the `docker` group is effectively root on that machine. Use a dedicated user and key
> for deploys, and don't reuse them for anything else.

### Configure GitHub

In the repository, go to **Settings → Environments → New environment** and create one called `production`.
You can optionally add yourself as a required reviewer, so each deploy waits for your approval.
Then add the following to the environment:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | Contents of `pstryk_deploy` (the private key) |
| Secret | `DEPLOY_KNOWN_HOSTS` | Contents of the `known_hosts` file from `ssh-keyscan` |
| Variable | `DEPLOY_HOST` | VPS hostname or IP. **Deploys are skipped until this is set.** |
| Variable | `DEPLOY_USER` | `deploy` |
| Variable | `DEPLOY_PORT` | Optional, defaults to `22` |
| Variable | `DEPLOY_PATH` | Optional. Checkout directory relative to the user's home; defaults to `pstryk`. |
| Variable | `PUBLIC_URL` | Optional, e.g. `https://pstryk.example.com`. Enables the post-deploy health check. |

The deploy runs `git reset --hard origin/main` in the checkout, so `docker-compose.yml` and the
Caddyfile stay in sync with the repository. `.env` is untracked and is never touched.
Don't edit tracked files on the server.

### Rolling back

Every image is also tagged `sha-<short commit>`. On the VPS:

```sh
cd ~/pstryk
PSTRYK_TAG=sha-abc1234 docker compose up -d pstryk
```

To make the rollback persist, revert the commit on `main` and let CD redeploy.

### Releases

Pushing a tag like `v1.2.0` also publishes the image as `1.2.0` and `1.2`. Tags don't trigger a deploy.

## Choosing where the broker lives

| Setup | `MQTT_URL` | Notes |
|---|---|---|
| Broker at home (Mosquitto, Home Assistant add-on) | `mqtt://100.x.y.z:1883` | Don't open 1883 to the internet. Put the VPS and your home broker on [Tailscale](https://tailscale.com) or WireGuard and use the private IP. |
| Hosted broker (HiveMQ Cloud, EMQX Cloud) | `mqtts://xxxx.s1.eu.hivemq.cloud:8883` | Easiest. TLS and authentication are handled by the provider. |
| Mosquitto on the same VPS | `mqtt://mosquitto:1883` | See below |

### Bundled Mosquitto

```sh
docker run --rm -it -v "$PWD/deploy/mosquitto:/m" eclipse-mosquitto:2 mosquitto_passwd -c /m/passwd pstryk
echo "COMPOSE_PROFILES=broker" >> .env       # so CD and plain `docker compose up` include it
docker compose up -d
```

This broker is only reachable from other containers. Before exposing it to devices outside the VPS,
add a TLS listener on 8883 to `deploy/mosquitto/mosquitto.conf` and publish only that port.

## Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f pstryk` |
| Status / health | `docker compose ps`, `curl https://<domain>/healthz` |
| Restart | `docker compose restart pstryk` |
| Change config | Edit `.env`, then `docker compose up -d` |
| Back up hooks | Atlas backups, or `mongodump --uri "$MONGODB_URI" --db pstryk --collection hooks` |

### Hardening checklist

- [ ] Strong `ADMIN_PASSWORD` (20+ random characters).
- [ ] Atlas Network Access limited to the VPS IP.
- [ ] VPS firewall allows only 22, 80 and 443 (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`).
- [ ] SSH key login only, with password authentication disabled.
- [ ] Optional: restrict `/admin` to Tailscale in the Caddyfile:

  ```
  @admin_external {
      path /admin*
      not remote_ip 100.64.0.0/10
  }
  respond @admin_external 404
  ```
