# MCP wiring

`mcp/servers.json` is the single source of truth. `ship init` merges it into each
repo's `.omp/mcp.json` (OMP-native) and `.mcp.json` (Claude Code / Cursor
fallback), preserving any server the repo already declared.

All three definitions use `${VAR}` / `${VAR:-default}` placeholders, which
OMP-native MCP config expands before connecting. Nothing secret is ever written
into a repo.

| Server        | Transport | Credential                                               | Owns                                                 |
| ------------- | --------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `revenuecat`  | http      | `REVENUECAT_V2_KEY`, else `~/.omp/revenuecat.key`         | Products, entitlements, offerings, paywalls, revenue  |
| `astro`       | http      | none (localhost-trusted)                                  | Keyword rankings, popularity/difficulty, suggestions  |
| `apple-ads`   | stdio     | `ASA_*` env, key at `~/.asc/asa-private.p8`               | Campaigns, ad groups, bids, search-term reports       |

## revenuecat

Hosted by RevenueCat at `https://mcp.revenuecat.ai/mcp`. The `!`-prefixed header
value is executed by OMP as a shell command, so the key is read at connect time
and never persisted into the config. Create a v2 **secret** key at
RevenueCat → Project Settings → API keys, then:

```bash
mkdir -p ~/.omp && printf '%s' 'sk_...' > ~/.omp/revenuecat.key && chmod 600 ~/.omp/revenuecat.key
```

Read-only is enough for analytics; write scope is required for `ship rc` mutations
and for the MCP to create products/offerings.

## astro

[Astro](https://tryastro.app) is a **macOS desktop app**. Its MCP server binds to
`127.0.0.1:8089` and drops any connection that does not originate from loopback,
so it cannot be reached directly from this WSL2 Linux host.

Enable it once on the Mac: **Astro → Settings → MCP Server → Enable**.

Then forward the port from the Mac to here, which makes the default
`http://127.0.0.1:8089/mcp` URL correct on both machines:

```bash
ssh -N -L 8089:127.0.0.1:8089 <mac-host>
```

Keep that tunnel up for the session. If Astro runs on a non-default port, or you
expose it some other way, override the whole URL instead:

```bash
export ASTRO_MCP_URL=http://127.0.0.1:9100/mcp
```

`ship doctor` probes the endpoint and reports it as *skipped* (not failed) when
the tunnel is down — the rest of the pipeline does not depend on it.

Tools: `list_apps`, `get_app_keywords`, `search_rankings`, `get_app_ratings`,
`extract_competitors_keywords`, `add_app`, `add_keywords`, `set_keyword_note`,
`set_keyword_tag`, `manage_tag`, `search_app_store`, `get_keyword_suggestions`.

Astro tracks **rank over time**, which the App Store exposes to nobody else.
`ship aso` covers the complementary half — live autocomplete harvesting and
top-10 competition scoring — with no subscription and no Mac. Use both: `ship aso`
to find candidate terms, Astro to watch what they actually do once shipped.

## apple-ads

[`apple-search-ads-mcp`](https://www.npmjs.com/package/apple-search-ads-mcp) —
74 typed tools over Campaign Management API v5, run via `npx`, no install step.

Credentials are **separate from App Store Connect**. In
[app-ads.apple.com](https://app-ads.apple.com):

1. **Account Settings → User Management → Invite User** with an API-capable role
   (e.g. *API Account Manager*), using an Apple ID you control. Accept the invite.
2. Generate a PKCS#8 P-256 key pair locally — Apple's older `openssl ecparam`
   output is *not* PKCS#8 and will fail to load:
   ```bash
   mkdir -p ~/.asc && chmod 700 ~/.asc
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ~/.asc/asa-private.p8
   openssl ec -in ~/.asc/asa-private.p8 -pubout -out ~/.asc/asa-public.pem
   chmod 600 ~/.asc/asa-private.p8
   ```
3. Sign in **as the invited API user** → **Account Settings → API**, paste
   `asa-public.pem`, click *Generate API Client*. Copy Client ID, Team ID and
   Key ID — they are shown once.
4. Export them (add to your shell profile):
   ```bash
   export ASA_CLIENT_ID=SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   export ASA_TEAM_ID=SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   export ASA_KEY_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   export ASA_ORG_ID=1234567
   ```
5. Give the same credentials to the CLI half so `ship ads` works too:
   ```bash
   ship ads login --client-id "$ASA_CLIENT_ID" --team-id "$ASA_TEAM_ID" \
     --key-id "$ASA_KEY_ID" --private-key ~/.asc/asa-private.p8 --org "$ASA_ORG_ID"
   ```

API v5 sunsets **2027-01-26** in favour of the Apple Ads Platform API. Both this
server and `asc ads` target v5.

## Division of labour

MCP servers are for *conversation* — open-ended questions, exploration, one-off
changes you describe in prose. The `ship` CLI is for *determinism* — gates, CI,
anything that must produce the same result twice. They talk to the same APIs.

Do not automate through MCP. Do not explore through CI.
