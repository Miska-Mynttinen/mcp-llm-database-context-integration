# Deploying to Google Cloud with Gemini

This guide runs the whole stack on one Compute Engine VM with Docker Compose, with Caddy for HTTPS and Gemini as the LLM. It needs no code changes.

- e2-medium VM, about $25/month
- Gemini through its OpenAI-compatible API: €0 on the free tier, or fractions of a cent per chat
- Replies in 1–3 s

Use a Gemini API key, not Vertex AI. Vertex needs an OAuth token that expires hourly, and the app only supports a static key.

The examples use `chat.miska-mynttinen.fi` on Cloudflare DNS. Replace it with your own domain.

## 1. Create the VM

```bash
gcloud config set project <PROJECT_ID>
gcloud services enable compute.googleapis.com
gcloud compute instances create mcp-chat \
  --zone=europe-north1-a --machine-type=e2-medium \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --tags=http-server,https-server
gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 \
  --target-tags=http-server,https-server
```

SSH in with `gcloud compute ssh mcp-chat`, then install Docker and add swap, so the build doesn't run out of memory:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt-get install -y rsync
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
exit   # log back in for the docker group to apply
```

## 2. Copy the code

From your laptop:

```bash
gcloud compute config-ssh
rsync -av --exclude node_modules --exclude dist \
  --include '.env*.example' --exclude '.env*' \
  ./ mcp-chat.europe-north1-a.<PROJECT_ID>:~/app/
```

This copies your code but not your local `.env*` files. You'll create fresh ones on the VM.

## 3. Get a Gemini key

GCP trial credits don't cover the Gemini API. You have two options:

- **Free tier:** create the key in a separate project with **no billing**. The rate limits are low, and Google may train on your prompts, including query results. Only use it with demo data.
- **Paid tier:** create the key in your main project, and buy at least $5 of prepaid credit in [AI Studio → Billing](https://ai.studio/projects).

Free-tier key:

```bash
gcloud projects create $GEMINI_PROJECT_ID
gcloud services enable generativelanguage.googleapis.com apikeys.googleapis.com \
  --project=$GEMINI_PROJECT_ID
gcloud services api-keys create --project=$GEMINI_PROJECT_ID --display-name=mcp-chat-gemini \
  --api-target=service=generativelanguage.googleapis.com
```

For a paid key, drop `--project` from the last two commands. The output ends with `"keyString": "AIza..."`.

Test the key:

```bash
KEY=AIza...
curl -s https://generativelanguage.googleapis.com/v1beta/openai/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"Say hi"}]}'
```

The status codes you might see instead of a reply: `402` means the prepaid balance is zero, `403` means the API isn't enabled yet, `404` means the model name is wrong, and `429` means you hit the rate limit (wait a minute).

On the VM, create `~/app/.env.llm`:

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-3.5-flash-lite
LLM_API_KEY=AIza...
LLM_TOOL_CALLING=native
```

Then run `chmod 600 .env.llm`. If tool use is weak, switch to `gemini-3.5-flash`. If tool calls keep failing, set `LLM_TOOL_CALLING=text`.

## 4. Secrets

The production compose file refuses to start with the template's dev secrets. Generate real ones on the VM:

```bash
cd ~/app
cp -n .env.example .env; cp -n .env.mcp.example .env.mcp; cp -n .env.limits.example .env.limits

sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^# POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^# DB_READONLY_PASSWORD=.*/DB_READONLY_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$(openssl rand -hex 32)/" .env.mcp
sed -i "s/^TRUST_PROXY=.*/TRUST_PROXY=1/" .env.limits
chmod 600 .env .env.mcp .env.limits
```

Then edit `.env` by hand. Set `SEED_USER_PASSWORD` to something strong, and add `PUBLIC_HOST=chat.miska-mynttinen.fi` (host name only).

**Only do this once, before the first start.** Postgres stores its password on first boot. If you change it later, the app can't connect anymore.

With the paid tier, it's also worth setting `CHAT_TOKENS_DAILY_GLOBAL` in `.env.limits` as a cost cap.

## 5. Domain and HTTPS

Make the VM's IP static (from your laptop):

```bash
IP=$(gcloud compute instances describe mcp-chat --zone=europe-north1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
gcloud compute addresses create mcp-chat-ip --region=europe-north1 --addresses=$IP
echo $IP
```

In Cloudflare, add an `A` record: name `chat`, value the IP, and proxy status **DNS only** (grey cloud). If you use the orange cloud, Cloudflare's SSL mode and extra proxy hop break Caddy and the per-IP limits.

Wait until this prints the VM's IP before you go on. Let's Encrypt locks you out for a while after a few failed attempts.

```bash
dig +short chat.miska-mynttinen.fi
```

No domain? Use `<IP>.sslip.io` as `PUBLIC_HOST`.

On the VM, create `~/app/docker-compose.gcp.yaml`:

```yaml
services:
  caddy:
    image: caddy:2
    command: caddy reverse-proxy --from ${PUBLIC_HOST} --to app:3000
    ports: ["80:80", "443:443"]
    volumes: [caddy_data:/data]
    depends_on: [app]
    restart: unless-stopped
volumes:
  caddy_data:
```

## 6. Start

```bash
echo "alias dc='docker compose -f docker-compose.yaml -f docker-compose.prod.yaml -f docker-compose.gcp.yaml'" >> ~/.bashrc
source ~/.bashrc

cd ~/app
dc up -d --build
dc ps               # everything running, db-seed exited (0)
dc logs -f caddy    # wait for "certificate obtained successfully"
```

The first build takes a few minutes.

| Problem | Fix |
| --- | --- |
| `set POSTGRES_PASSWORD in .env` | A secret is missing (step 4) |
| `still use the public development values` | A template secret wasn't replaced (step 4) |
| Caddy logs `challenge` or `NXDOMAIN` | DNS isn't ready. Fix it, then `dc restart caddy` |
| Build killed / exit 137 | Out of memory. Check the swap with `free -h` |

After you edit an `.env*` file, run `dc up -d` again.

**Demo data** (optional; the production setup seeds only users):

```bash
dc run --rm db-seed node dist/src/seed/cli.js --sample-data
```

**Monitoring** (optional): set `GRAFANA_ADMIN_PASSWORD` in `.env`, run `dc --profile monitoring up -d`, then tunnel to Grafana with `gcloud compute ssh mcp-chat -- -L 3002:localhost:3002` and open http://localhost:3002.

## Check it works

- `curl -I https://chat.miska-mynttinen.fi` returns `200`.
- You can log in as `user1`, and "What tables are there?" gets answered through a tool call.
- `nc -zv <IP> 5432` and `nc -zv <IP> 3001` both fail from your laptop.

## Updating

Rerun the rsync from step 2, then run `dc up -d --build` on the VM. Your env files, database and certificate are kept.

## Alternative: Ollama on the VM

To avoid an external LLM API, run the model on the VM itself. Expect 10–60 s per reply and weaker SQL. You need an e2-standard-4 (16 GB, about $100/month, no swap needed) instead of the e2-medium.

Skip step 3 and use this `.env.llm`:

```env
LLM_PROVIDER=ollama
LLM_BASE_URL=http://ollama:11434
LLM_MODEL=qwen2.5:3b
LLM_CONTEXT_LENGTH=8192
```

Merge an `ollama` service and volume into `docker-compose.gcp.yaml`:

```yaml
services:
  ollama:
    image: ollama/ollama
    volumes: [ollama_data:/root/.ollama]
    restart: unless-stopped
volumes:
  ollama_data:
```

After `dc up`, pull the model with `dc exec ollama ollama pull qwen2.5:3b`.
