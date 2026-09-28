# Deploy to Google Cloud with Gemini (guide only)

## Context
You want to run this app (Express chat app + MCP server + PostgreSQL, see
`docker-compose.yaml` / `docker-compose.prod.yaml`) on Google Cloud, with an LLM
provided by Google and no tokens bought from OpenAI/Anthropic. **No repo changes**:
everything below is commands and untracked files you create on the VM.

The repo is already deploy-ready for a single Docker host: `docker-compose.prod.yaml`
enforces real secrets, hides Postgres/MCP, and publishes the app on `127.0.0.1:3000`
for a reverse proxy. So the simplest GCP target is **one Compute Engine VM running
Docker Compose**, plus Caddy for HTTPS on a subdomain of your own domain (the example is
`chat.miska-mynttinen.fi`, with DNS at Cloudflare; see step 5). (Cloud Run would need Cloud SQL, two services
and service-to-service auth — much more work for no gain here.)

The LLM is Gemini via your GCP project, with zero code changes: `LLM_PROVIDER=openai`
pointed at Gemini's OpenAI-compatible endpoint (`src/llm/providers/openai.ts` already
accepts `baseUrl`).
- VM: e2-medium (2 vCPU, 4 GB) ≈ $25/mo
- Replies: ~1–3 s, good tool use
- LLM cost: €0 on the Gemini free tier (key in a separate no-billing project), or
  prepaid paid-tier credit at fractions of a cent per turn (see step 3a)

Note: Vertex AI's OpenAI endpoint needs a 1-hour OAuth token, which the app can't
refresh (it reads a static `LLM_API_KEY`), so use the **Gemini API key** from your GCP
project instead.

Want no external LLM API at all? See
[Alternative: self-hosted Ollama](#alternative-self-hosted-ollama-no-external-llm) at the bottom.

## Steps

### 1. GCP project and VM
```bash
gcloud config set project <PROJECT_ID>
gcloud services enable compute.googleapis.com
gcloud compute instances create mcp-chat \
  --zone=europe-north1-a --machine-type=e2-medium \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --tags=http-server,https-server
gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 \
  --target-tags=http-server,https-server   # skip if it already exists
```
Only 22/80/443 are open; Postgres, MCP (3001) and metrics stay internal. Ports 80 and 443
are for Caddy and its Let's Encrypt certificate (step 5).

Don't reserve a static IP here with a plain `gcloud compute addresses create`: that makes a
new, unattached address. Step 5a instead keeps the IP the VM just got and makes it static.
**Tip:** 5a (static IP) and 5b (Cloudflare DNS record) only need the VM to exist, so you can do
them right now. The DNS record then has time to take effect before Caddy starts in step 6.

SSH into the VM (`gcloud compute ssh mcp-chat`; the first run creates an SSH key for
you) and install Docker Engine + compose plugin, plus 2 GB swap so the frontend build
doesn't OOM on e2-medium:
```bash
curl -fsSL https://get.docker.com | sh    # ignore its "rootless mode" suggestion
sudo usermod -aG docker $USER             # run docker without sudo
sudo apt-get install -y rsync             # needed for step 2

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # keep swap after reboot

exit    # log out so the docker group applies
```
Reconnect and check:
```bash
gcloud compute ssh mcp-chat
docker run --rm hello-world   # works without sudo
free -h                       # Swap: 2.0Gi
```
Step 2 runs from your laptop, not the VM (`exit` first).



### 2. Copy the code
From your laptop, in the repo folder after cd:ing to it (it has no remote yet):
```bash
gcloud compute config-ssh     # adds an ssh alias: mcp-chat.europe-north1-a.<PROJECT_ID>
                              # rerun it whenever the VM's IP changes (see 5a)
rsync -av --exclude node_modules --exclude dist \
  --include '.env*.example' --exclude '.env*' \
  ./ mcp-chat.europe-north1-a.<PROJECT_ID>:~/app/
```

The filters keep your local secrets (`.env`, `.env.llm`, ...) off the VM, but copy the
`*.example` templates that step 4 needs.
The Dockerfiles build everything (`npm ci` + `npm run build`) on the VM.

**How the env files work (read before 3c and 4).** Don't edit any `.env*` file before
running the `cp` commands, and don't edit anything on your laptop at all:
- The `*.example` files are templates. They're committed to git, so never put secrets in
  them; leave them unchanged.
- Your local `.env`, `.env.llm`, ... are for local development only. rsync skips them, so
  editing them has no effect on the VM.
- On the VM, the order is always: `cp X.example X` makes a fresh copy of the template, then
  you edit that copy (`X`) with `nano`. Compose reads only the copies.
- Run each `cp` once. Running it again overwrites the copy and your edits with the template.
  `cp -n` (no-clobber) is the safe variant if you're unsure whether a file already exists.
- Later rsyncs (see [Updating later](#updating-later)) leave the VM's copies alone: they're
  excluded, and rsync doesn't delete files without `--delete`.


### 3. LLM (Gemini)
**How it works:** Google exposes Gemini through an OpenAI-compatible REST API. The app's
`openai` provider is just the official OpenAI SDK with a configurable base URL, so pointing
it at Google's endpoint makes it talk to Gemini instead. No code changes, and no OpenAI
account is involved. You only need a Gemini API key from your GCP project.

**3a. Choose where the key lives.** GCP Free Trial credits **can't** pay for the Gemini API.
Since March 2026 it's excluded from the trial. Pick one:

- **Free tier (€0, recommended on a Free Trial):** create the key in a **separate project
  with no billing account**. The VM stays in `<PROJECT_ID>` and runs on the trial credits,
  and Gemini runs on its free tier. There are two catches. Free-tier requests have low rate
  limits (see the 429 in 3b); one chat turn with tool calls makes several requests. More
  importantly, Google may use free-tier prompts and replies to improve its products, and
  those include rows the database tools return. Only use it with demo data, never real
  personal or customer data.

- **Paid tier:** create the key in `<PROJECT_ID>` itself (billing is linked) and buy at
  least $5 of Gemini prepay credit (see the billing note below). This is real money, not
  trial credit, but prompts aren't used for training and the limits are higher.


Free-tier key (from your laptop). First choose an ID for the new project, `<GEMINI_PROJECT_ID>`
below. The name has no effect on how the key works, but Google's rules apply: 6–30
characters; lowercase letters, digits and hyphens; starts with a letter; doesn't end with a
hyphen; no restricted words like `google`. It must be globally unique and can't be changed
later. Something like `mcp-chat-gemini-<random digits>` or `<yourname>-mcp-gemini` works.
If the ID is taken, `gcloud` says so; pick another.

```bash
gcloud projects create $GEMINI_PROJECT_ID      # never link billing to this one
gcloud services enable generativelanguage.googleapis.com apikeys.googleapis.com \
  --project=$GEMINI_PROJECT_ID
gcloud services api-keys create --project=$GEMINI_PROJECT_ID --display-name=mcp-chat-gemini \
  --api-target=service=generativelanguage.googleapis.com
```

Always pass `--project` for this project, and don't run `gcloud config set project` with it.
Otherwise the VM commands in the other steps would stop targeting `<PROJECT_ID>`.
`gcloud projects list` shows the exact ID if you lose it.
For a paid-tier key, run the same last two commands without `--project` (they then use
`<PROJECT_ID>`).

The output ends with `"keyString": "AIza..."`. That is your key. `--api-target` restricts
the key to the Gemini API, so a leaked key can't call other paid Google APIs. To print the
key again later: `gcloud services api-keys list --project=$GEMINI_PROJECT_ID` (omit `--project` for a paid-tier key), then
`gcloud services api-keys get-key-string <KEY_ID>`.

Console alternative: [AI Studio → API keys](https://aistudio.google.com/apikey) →
Create API key. There, pick "create in new project" for the free tier, or `<PROJECT_ID>`
for the paid tier.

**3b. Test the key before deploying** (from your laptop, still with no VM involved):
```bash
KEY=AIza...
# Which models can this key use? Pick an ID from here for LLM_MODEL.
curl -s https://generativelanguage.googleapis.com/v1beta/openai/models \
  -H "Authorization: Bearer $KEY" | grep '"id"'
# One chat request, through the same endpoint the app will use
curl -s https://generativelanguage.googleapis.com/v1beta/openai/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"Say hi"}]}'
```

A JSON reply with `"choices"` means the key, API and model all work. A 403 means the API
isn't enabled yet or the key restriction is wrong. A 404 means the model name is wrong, or
the model is retired for new users. The error message then names its replacement.
A 402 means the key and model are fine but the prepaid Gemini balance is $0: the key sits
in a billing-linked project (see the billing note below). A 429 means you hit a rate limit,
which happens quickly on the free tier. Wait a minute and retry.


**3c. Create `.env.llm` on the VM.** The step 2 rsync intentionally skipped your local
`.env.llm`, and compose refuses to start without it:
```bash
gcloud compute ssh mcp-chat
cd ~/app
cp .env.llm.example .env.llm
nano .env.llm      # replace the active (uncommented) settings with the block below
chmod 600 .env.llm # it contains the API key
```

```
LLM_PROVIDER=openai
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-3.5-flash-lite
LLM_API_KEY=AIza...
LLM_TOOL_CALLING=native
```

| Variable | Why this value |
|---|---|
| `LLM_PROVIDER=openai` | Selects the OpenAI-SDK provider ([src/llm/providers/openai.ts](src/llm/providers/openai.ts)). It speaks the protocol, not the company. |
| `LLM_BASE_URL` | Google's OpenAI-compatible endpoint. Keep the trailing `/openai/`. The SDK appends `chat/completions`. |
| `LLM_MODEL` | `gemini-3.5-flash-lite`: cheapest and fast. Use `gemini-3.5-flash` if SQL or tool use is weak. Drop the `models/` prefix the list shows. The 2.5 models are no longer available to new users. Avoid `*-latest` aliases (they change silently), `*-preview`, and task-specific models (tts, image, live, embedding). |
| `LLM_API_KEY` | The key from 3a. The app sends it as `Authorization: Bearer`, which Gemini's endpoint accepts. |
| `LLM_TOOL_CALLING=native` | Gemini's own tool-calling API, the most reliable tool use. `native` is also the default for `openai`, so this line can be left out. See the note below. |

The example file's `LLM_BASE_URL=http://localhost:11434` must be replaced, not just left
below your values. With duplicate keys it's unclear which value wins, so keep one of each.
`LLM_CONTEXT_LENGTH` is Ollama-only, and the app ignores it here. `LLM_TIMEOUT_SECONDS`
(default 95) is how long each Gemini request may take before it's retried or reported as
unavailable. Three attempts then stay just under the server's 5-minute request limit. Above
about 98, a stalled request hits that limit first, and the browser shows "Could not reach the
server" instead of the "temporarily unavailable" message.

**Tool-calling mode: `native` or `text`.**
- **`native`**: Gemini 3+ attaches a "thought signature" to each tool call and returns a 400
  if the next request doesn't send it back. The app's OpenAI provider sends tool calls back
  exactly as it received them, so the signature is kept. If Gemini still writes invalid arguments
  for a tool (`MALFORMED_FUNCTION_CALL`), that chat turn fails with a 500; the app doesn't
  retry in this mode.
- **`text`**: the fallback if native tool calling misbehaves. The tools are described in the
  system prompt ([src/llm/textToolProtocol.ts](src/llm/textToolProtocol.ts)), and the model
  replies with JSON. Gemini sometimes tries a native call anyway, which Google blocks
  (`MALFORMED_FUNCTION_CALL`). The app then retries once with a reminder to write the JSON as
  text, so an occasional turn can still fail.
- **Switching:** change `LLM_TOOL_CALLING` in `~/app/.env.llm` on the VM, then run `dc up -d`
  (step 6b), which recreates only the app. Nothing else changes: the database, users and
  conversations are kept.

**Optional: check native tool calling before deploying.** Run the app on your laptop (see the
local setup in [README.md](README.md)) with a local `.env.llm` holding the settings above. Ask a
question that takes two tool steps, such as "What columns does the product table have, and how
many rows does it have?". The answer should arrive with no 400 error about a thought signature,
and the app log's `Chat turn completed` line should show `toolSteps` of 2 or more and
`failedTools: 0`. That also confirms tool results pair with their calls (by call ID).


**Billing note (paid-tier key only):** The Gemini API has a free tier only for projects
**without** a linked billing account. `<PROJECT_ID>` has billing (the VM needs it), so a key
there is on the paid tier, and trial credits don't count toward it.
[Gemini billing](https://ai.google.dev/gemini-api/docs/billing) has two plans:
- **Prepay** (the default for new users): buy credits in
  [AI Studio → Billing](https://ai.studio/projects) → **Buy credits**. The minimum is $5.
  At a $0 balance the API returns **402** ("prepayment credits are depleted"), and every
  key on that billing account stops working. Calls resume within about 10 minutes of a
  top-up. The upside is a hard spending cap.
- **Postpay** (eligible accounts, switch on the same page): billed monthly with the rest
  of your GCP costs, so there's no 402 surprise, but also no hard cap.

Flash-Lite costs fractions of a cent per chat turn, so $5 goes a long way for a demo. Also
cap usage with `CHAT_TOKENS_DAILY_GLOBAL` in step 4, and on postpay add a budget alert under
Billing → Budgets & alerts.


### 4. Secrets and config on the VM (`~/app`)

**What "prod mode" is.** You don't switch it on anywhere. The step 6 command adds
`docker-compose.prod.yaml`, and that file sets `NODE_ENV=production` for the app, db-seed and
mcp-server. In production mode two checks run, and either one stops the stack:
1. **Compose, before any container starts.** `POSTGRES_PASSWORD`, `DB_READONLY_PASSWORD`,
   `JWT_SECRET` and `SEED_USER_PASSWORD` must be set and non-empty in `.env`. Otherwise
   `up` aborts with, for example, `set POSTGRES_PASSWORD in .env (openssl rand -hex 32)`.
2. **The app and MCP server, at startup.** They refuse the public development values that
   ship in the `*.example` files, which anyone can read on GitHub
   ([packages/runtime/src/secrets.ts](packages/runtime/src/secrets.ts)). The container then exits,
   and `docker compose ... logs app` (`dc logs app`, step 6) shows
   `NODE_ENV=production but JWT_SECRET, ... still use the public development values`.

So every secret the templates ship with has to be replaced:

| File | Variable | Template value | Set it to |
|---|---|---|---|
| `.env` | `JWT_SECRET` | `saltsecret-...-00` (dev value, refused) | `openssl rand -hex 32` |
| `.env` | `POSTGRES_PASSWORD` | commented out (compose aborts) | `openssl rand -hex 32` |
| `.env` | `DB_READONLY_PASSWORD` | commented out (compose aborts) | `openssl rand -hex 32` |
| `.env` | `SEED_USER_PASSWORD` | `password` (refused) | a strong password you'll type to log in as `user1`..`user5` |
| `.env` | `PUBLIC_HOST` | not in the template | `chat.miska-mynttinen.fi`, the host name only (no `https://`), or `<VM_IP>.sslip.io` without a domain (step 5c) |
| `.env.mcp` | `MCP_AUTH_TOKEN` | `dev-mcp-token-...` (refused) | `openssl rand -hex 32` (at least 32 characters) |
| `.env.limits` | `TRUST_PROXY` | `0` | `1`: exactly one proxy (Caddy) is in front. With `0`, every client shares Caddy's IP and its rate limits. This assumes the Cloudflare record is DNS only (grey cloud, step 5b). |
| `.env.limits` | `CHAT_TOKENS_DAILY_GLOBAL` | `off` | optional: a daily token cap, such as `2000000`, as a cost limit on Gemini |

Everything else in the templates can stay as it is. Compose reads `.env` only to fill in the
`${...}` values in the compose files. The app doesn't read it directly, and `PORT`,
`MCP_SERVER_URLS` and the DB settings are fixed in `docker-compose.yaml`.


**Commands.** Env files don't run shell commands, so writing `JWT_SECRET=$(openssl rand -hex 32)`
in `nano` would store that literal text. Generate the values in the shell instead. `sed`
writes a fresh random value into each line:

```bash
cd ~/app
cp -n .env.example .env; cp -n .env.mcp.example .env.mcp; cp -n .env.limits.example .env.limits
# (.env.llm was already created in step 3c)

sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^# POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^# DB_READONLY_PASSWORD=.*/DB_READONLY_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$(openssl rand -hex 32)/" .env.mcp
sed -i "s/^TRUST_PROXY=.*/TRUST_PROXY=1/" .env.limits

nano .env    # set SEED_USER_PASSWORD yourself, and add PUBLIC_HOST=chat.miska-mynttinen.fi (step 5c)
chmod 600 .env .env.mcp .env.limits

# Check: every line should show a real value, none empty or commented out
grep -E '^#? ?(JWT_SECRET|POSTGRES_PASSWORD|DB_READONLY_PASSWORD|SEED_USER_PASSWORD|PUBLIC_HOST)=' .env
grep '^MCP_AUTH_TOKEN=' .env.mcp; grep '^TRUST_PROXY=' .env.limits
```

Notes:
- Run the `sed` lines **once, before the first `up`**. Postgres stores `POSTGRES_PASSWORD`
  in its data volume on first start. If you generate a new one later, the app can no longer
  log in to the database. Fixing that means changing the password inside Postgres or deleting
  the volume, which deletes all data. A new `JWT_SECRET` only logs everyone out.
- `SEED_USER_PASSWORD` can't be left empty under compose, even though the template says
  "empty seeds no users": compose requires it. Set it to at least 8 characters. Users can also
  sign up themselves on the login page.
- `SEED_USER_PASSWORD` is only used when the users are first created. Changing it later
  doesn't change existing passwords (that takes `npm run seed -- --reset-password`).
- With `--profile monitoring`, also set `GRAFANA_ADMIN_PASSWORD` in `.env`. Prod mode
  doesn't check it and it defaults to `admin`. Grafana is only reachable through the SSH
  tunnel, but set it anyway.



### 5. Domain and HTTPS (Caddy)

**How it works:** the app only listens on the VM's loopback (`127.0.0.1:3000`), so the internet
can't reach it directly. Caddy is a small web server container that listens on ports 80 and 443
and forwards requests to the app over the compose network. On its first start it gets a free
Let's Encrypt certificate for `PUBLIC_HOST` by itself, renews it automatically, and redirects
HTTP to HTTPS. For that to work, the name must already point to the VM when Caddy starts. So the
order is: fixed IP (5a) → DNS record (5b) → `PUBLIC_HOST` (5c) → overlay file (5d) → step 6.

This guide uses the subdomain `chat.miska-mynttinen.fi` as the example. Its DNS is hosted at
Cloudflare (the domain's nameservers point there), so the record is added in the Cloudflare
dashboard. Nothing changes at the domain registrar (purchase place), and the main site on the bare
domain isn't affected. A new subdomain record only adds a name.

**5a. Give the VM a fixed IP.** By default the VM's external IP is ephemeral: it can change
when the VM is stopped and started, and the DNS record would then point to the wrong machine.
From your laptop, promote the current IP to a static one (the VM keeps it, and nothing
restarts):

```bash
IP=$(gcloud compute instances describe mcp-chat --zone=europe-north1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
echo $IP
gcloud compute addresses create mcp-chat-ip --region=europe-north1 --addresses=$IP
```

If you already ran a plain `gcloud compute addresses create mcp-chat-ip` without `--addresses`
(an earlier version of step 1 had it), that created a *separate*, unattached address, and the
command above fails because the name is taken. Either delete it (`gcloud compute addresses delete mcp-chat-ip --region=europe-north1`)
and run the commands above, or attach it to the VM in place of the ephemeral IP:
```bash
gcloud compute instances delete-access-config mcp-chat --zone=europe-north1-a \
  --access-config-name=external-nat
gcloud compute instances add-access-config mcp-chat --zone=europe-north1-a \
  --access-config-name=external-nat \
  --address=$(gcloud compute addresses describe mcp-chat-ip --region=europe-north1 --format='get(address)')
```

(`external-nat` is the name `gcloud` gives the VM's external IP. If the first command says it
doesn't exist, `gcloud compute instances describe mcp-chat --zone=europe-north1-a` shows the real
name under `accessConfigs`.) `gcloud compute config-ssh` from step 2 needs a rerun after this,
because the IP changed.

A reserved address that isn't attached to a running VM is still billed. If you delete the VM
later, delete the address too.

**5b. Point the subdomain at the VM (Cloudflare).** First print the static IP. This works
whichever way you did 5a:
```bash
gcloud compute addresses describe mcp-chat-ip --region=europe-north1 --format='get(address)'
```

It prints four numbers like `34.88.123.45`. That's the value for Cloudflare. (It's the same
value `echo $IP` showed in 5a, if you took the promote path.) Paste the numbers themselves:
Cloudflare doesn't know your shell variables, so typing `$IP` there won't work.

In the Cloudflare dashboard, open the domain → **DNS → Records → Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `chat` (Cloudflare appends the domain, so this becomes `chat.miska-mynttinen.fi`) |
| IPv4 address | the numbers printed above, e.g. `34.88.123.45` |
| Proxy status | **DNS only** (grey cloud). Click the orange cloud to turn it off. |
| TTL | Auto |

Save. Check from your laptop that the name resolves to the VM, not to Cloudflare:
```bash
dig +short chat.miska-mynttinen.fi    # must print exactly the VM's IP
```

If it prints other addresses (Cloudflare's, such as `104.x` or `172.67.x`), the record is still
proxied: switch it to grey. If it prints nothing, wait a minute or two and retry. Don't start
Caddy (step 6) until this shows the right IP. Let's Encrypt allows only a few failed attempts
per hour, so starting too early can lock you out for a while.

**Why grey cloud (DNS only), not orange (proxied):**
- With grey, browsers connect straight to the VM. Caddy handles TLS and Let's Encrypt's
  certificate check directly, with nothing in between.
- Orange puts Cloudflare in the middle, and then Cloudflare's SSL mode applies. That setting is
  for the whole domain, including the main site. With "Flexible", Cloudflare talks plain HTTP to
  the VM, Caddy redirects it to HTTPS, and the browser ends up in an endless redirect loop. It
  would need "Full (strict)", which might not suit the main site.
- Orange also adds a second proxy in front of Caddy. With `TRUST_PROXY=1` (step 4) the app would
  see Cloudflare's IP as every client's IP, so all users would share one set of per-IP rate
  limits and token budgets. `TRUST_PROXY=2` fixes that, but anyone who calls the VM's IP directly
  could then fake their IP with an `X-Forwarded-For` header.

Switching to orange later is possible if you want Cloudflare's DDoS protection and caching. It
takes "Full (strict)", `TRUST_PROXY=2`, and ideally a GCP firewall rule that allows 80/443 only
from Cloudflare's IP ranges.


**No domain?** Skip 5b and use `<VM_IP>.sslip.io` (for example `34.88.1.2.sslip.io`) as
`PUBLIC_HOST`. sslip.io is a public DNS service that resolves such names to the IP inside them,
and Let's Encrypt works for it. You still want the static IP from 5a, since the name contains it.


**5c. Set `PUBLIC_HOST` on the VM.** In `~/app/.env` (step 4's `nano .env`, if you didn't add it
there):
```
PUBLIC_HOST=chat.miska-mynttinen.fi
```
Only the host name: no `https://`, no trailing slash, no port. Compose puts this value into the
Caddy command below.


**5d. Create the compose overlay** `~/app/docker-compose.gcp.yaml`. It exists only on the VM
(not in git) and adds the Caddy service to the stack. On the VM:

```bash
cd ~/app
cat > docker-compose.gcp.yaml <<'EOF'
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
EOF
```


The quotes in `<<'EOF'` matter. They keep the shell from replacing `${PUBLIC_HOST}` while writing
the file. Compose fills it in from `.env` at start. (Pasting the YAML into `nano` works too.)

What each line does:
- `caddy reverse-proxy --from ... --to app:3000`: serve `PUBLIC_HOST` over HTTPS and forward
  everything to the app container. `app` is the service name on the compose network, so this
  bypasses the loopback port.
- `ports: 80, 443`: the only ports open to the internet (the firewall rule from step 1). Port 80
  is needed for Let's Encrypt's check and the HTTP→HTTPS redirect.
- `caddy_data`: a volume that stores the certificate. Keep it: if it's deleted, Caddy requests
  a new certificate on every start, and Let's Encrypt limits how many it issues per week.

Caddy passes the original Host header to the app, so the browser's origin matches the app's own
and `ALLOWED_ORIGINS` can stay empty. It is exactly one proxy, which is why step 4 sets
`TRUST_PROXY=1`.

To check it after step 6: `dc logs caddy` should show `certificate obtained
successfully`. Errors there mentioning `challenge` or `NXDOMAIN` mean the DNS record from 5b
isn't right yet. Fix it, then `dc restart caddy`.



### 6. Start

**How it works:** one command builds the images on the VM and starts the whole stack in order:
postgres → db-seed (creates the app tables, the read-only login and `user1`..`user5`, then
exits) → mcp-server and app → caddy, which fetches the certificate. The first build takes
several minutes on e2-medium; that's what the swap from step 1 is for. Later starts reuse the
built images and take seconds.

**6a. Check that everything is in place.** On the VM:

```bash
cd ~/app
ls -la .env .env.llm .env.mcp .env.limits docker-compose.gcp.yaml   # all five exist (3c, 4, 5d)
```

Rerun the `grep` check from the end of step 4: every value is real, and `PUBLIC_HOST` is set
(5c). And from your laptop, `dig +short chat.miska-mynttinen.fi` must print the VM's IP (5b).
If it doesn't, wait: Caddy starts asking Let's Encrypt for a certificate right away, and failed
attempts count against its hourly limit.


**6b. Define a shorthand.** Every compose command needs all three files, in this order. An alias
saves typing them:

```bash
echo "alias dc='docker compose -f docker-compose.yaml -f docker-compose.prod.yaml -f docker-compose.gcp.yaml'" >> ~/.bashrc
source ~/.bashrc
```

Wherever this guide writes `docker compose ...`, it means `dc`. The file paths are relative, so
run `dc` from `~/app`.

**6c. Start the stack:**
```bash
cd ~/app
dc up -d --build
```

**6d. Watch it come up:**
```bash
dc ps              # postgres, mcp-server, app, caddy: running (healthy); db-seed: exited (0)
dc logs db-seed    # ends with "Seeded 5 users into ..."
dc logs -f caddy   # wait for "certificate obtained successfully", then Ctrl+C
```


If something doesn't start:

| Symptom | Cause | Fix |
|---|---|---|
| `up` aborts with `set POSTGRES_PASSWORD in .env ...` (or another variable) | A secret is missing | Step 4 |
| app or mcp-server exits; `dc logs app` says `still use the public development values` | A template secret wasn't replaced | Step 4 |
| app exits; `dc logs app` mentions an `LLM_*` setting | `.env.llm` is wrong or missing | Step 3c |
| Chat says the AI service is temporarily unavailable; `dc logs app` shows `LLM request failed` with `Unavailable: 503 ...` or `Unavailable: Request timed out.` | Gemini is overloaded (a Google-side outage, usually brief) | Wait and retry, or set `LLM_MODEL=gemini-3.5-flash` in `.env.llm` and `dc up -d` |
| caddy logs mention `challenge` or `NXDOMAIN` | DNS doesn't point to the VM yet | 5b, then `dc restart caddy` |
| Build stops with `Killed` or exit code 137 | Out of memory | Check swap with `free -h` (step 1) |

After fixing an `.env*` file, run `dc up -d` again. Compose recreates only the containers whose
config changed. (Don't change `POSTGRES_PASSWORD` after the first start; see step 4.)



**6e. Optional: demo data.** The prod override seeds only users and the read-only login, with no
sample tables, so a question like "What tables are there?" has little to find. To add the
sample tables (product, shipment, unit, complaints):
```bash
dc run --rm db-seed node dist/src/seed/cli.js --sample-data
```
It only inserts rows that are missing, so running it again is harmless. This is the demo data
that's fine to send to the Gemini free tier (3a).


**6f. Optional: monitoring (Grafana, Prometheus, Loki).** Set `GRAFANA_ADMIN_PASSWORD` in `.env`
first (step 4 notes), then:
```bash
dc --profile monitoring up -d
```
Grafana listens only on the VM's loopback, so nothing new is exposed to the internet. From your
laptop, open an SSH tunnel and browse to http://localhost:3002:
```bash
gcloud compute ssh mcp-chat -- -L 3002:localhost:3002
```
Keep the `--profile monitoring` flag on later `dc up` commands too, or the monitoring
containers won't be rebuilt or recreated.


## Verification
1. Step 6d passed, and `dc logs app` shows no config or secret errors and lists the MCP tools
   it discovered.
2. `curl -I https://chat.miska-mynttinen.fi` (your `PUBLIC_HOST`) returns 200 with a valid certificate.
3. Log in as `user1` / `SEED_USER_PASSWORD` in the browser and ask "What tables are there?".
   The reply should come from a database tool call. Then ask something that takes two tool
   steps (see the note at the end of 3c). `dc logs app` should show no `LLM request failed`
   warnings. A 400 mentioning a thought signature means the running build predates the fix:
   rerun [Updating later](#updating-later), or set `LLM_TOOL_CALLING=text` in the meantime.
4. From your laptop, `nc -zv <IP> 5432` and `nc -zv <IP> 3001` must fail (not exposed). `<IP>`
   is the static IP from 5b.
5. Confirm usage in Cloud console → Generative Language API metrics (in `<GEMINI_PROJECT_ID>`
   for a free-tier key).

## Updating later
1. From your laptop, in the repo folder: rerun the `rsync` command from step 2.
2. On the VM: `cd ~/app && dc up -d --build` (add `--profile monitoring` if you use it).

Your `.env*` files on the VM, the database and the certificate (`caddy_data`) are kept.

**VM set up with `LLM_TOOL_CALLING=text`?** Earlier versions of this guide required it for
Gemini. To move to `native`, run the two steps above first, since native mode needs the current
code. Then change the line in `~/app/.env.llm` to `LLM_TOOL_CALLING=native` and run `dc up -d`. To
roll back, set it to `text` and run `dc up -d`.






---
---
---






## ALTERNATIVE: self-hosted Ollama (no external LLM)

Runs the LLM on the VM itself: an Ollama container with a small tool-capable model
(`qwen2.5:3b`), using `src/llm/providers/ollama.ts`. Also zero code changes.
- VM: e2-standard-4 (4 vCPU, 16 GB) ≈ $100/mo
- Replies: ~10–60 s on CPU, weaker SQL/tool use
- LLM cost: none beyond the VM

Follow the main guide above, with these differences.

### 1. VM (instead of the `instances create` in step 1)
```bash
gcloud compute instances create mcp-chat \
  --zone=europe-north1-a --machine-type=e2-standard-4 \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --tags=http-server,https-server
```
The rest of step 1 is unchanged; the swap is not needed with 16 GB. Ollama (11434) stays
internal like Postgres and MCP.

### 2. LLM (replaces step 3)
Skip the Gemini API, key and test (3a, 3b). Create `.env.llm` as in 3c, with this content:
```
LLM_PROVIDER=ollama
LLM_BASE_URL=http://ollama:11434
LLM_MODEL=qwen2.5:3b                 # qwen2.5:1.5b on a smaller VM
LLM_CONTEXT_LENGTH=8192
# LLM_TOOL_CALLING defaults to text for ollama; qwen2.5 also handles native — try both
```

### 3. Secrets (step 4)
Unchanged. `CHAT_TOKENS_DAILY_GLOBAL` is optional here, since there is no per-token cost.

### 4. Compose overlay (replaces step 5)
`~/app/docker-compose.gcp.yaml`:
```yaml
services:
  caddy:
    image: caddy:2
    command: caddy reverse-proxy --from ${PUBLIC_HOST} --to app:3000
    ports: ["80:80", "443:443"]
    volumes: [caddy_data:/data]
    depends_on: [app]
    restart: unless-stopped
  ollama:
    image: ollama/ollama
    volumes: [ollama_data:/root/.ollama]
    restart: unless-stopped
volumes:
  caddy_data:
  ollama_data:
```
The `PUBLIC_HOST` note from step 5 applies as-is.

### 5. Start (after step 6)
Pull the model once:
```bash
dc exec ollama ollama pull qwen2.5:3b
```

### 6. Verification
- `dc ps` also shows ollama running.
- `nc -zv <IP> 11434` must also fail from your laptop.
- Skip the Generative Language API metrics check.
