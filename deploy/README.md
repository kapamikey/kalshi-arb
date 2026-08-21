# Deploying the Kalshi bot on a VM

The bot is I/O-bound (HTTP polling), so the cheapest small always-on VM is plenty.
Recommended: **DigitalOcean droplet, 1 vCPU / 1 GB RAM, Ubuntu 24.04 (~$6/mo)**. Any
equivalent (Hetzner, Lightsail, Vultr) works the same way.

Two independent services get deployed: `kalshi-bot` (the real account — dry-run
by default) and `kalshi-papertrader` (a fully simulated $1000 bankroll, never
touches the real account regardless of flags). Each can be stopped/restarted
without affecting the other.

## 1. Provision & secure

```bash
# On the droplet, as root:
adduser --disabled-password --gecos "" kalshi
ufw allow OpenSSH        # SSH inbound only — the bot only makes outbound HTTPS
ufw --force enable
apt update && apt install -y python3 python3-venv python3-pip git
```

## 2. Copy the project + secrets (out-of-band, NOT via git)

The private key and `.env` must never be committed. Clone the repo from GitHub,
then copy secrets directly:

```bash
# On the VM, as the kalshi user:
git clone https://github.com/kapamikey/kalshi-arb.git /home/kalshi/kalshi-arb

# From your Mac:
scp ~/Documents/GitHub/kalshi-arb/.env                                kalshi@YOUR_VM_IP:/home/kalshi/kalshi-arb/.env
scp ~/Documents/GitHub/kalshi-arb/config/kalshi-private-key.pem       kalshi@YOUR_VM_IP:/home/kalshi/kalshi-arb/config/kalshi-private-key.pem
```

On the VM, confirm `KALSHI_PRIVATE_KEY_PATH` in `.env` points at
`config/kalshi-private-key.pem` (relative path, resolved from the service's
`WorkingDirectory`) and lock the key down:

```bash
chmod 600 /home/kalshi/kalshi-arb/config/kalshi-private-key.pem
chmod 600 /home/kalshi/kalshi-arb/.env
```

## 3. Install dependencies (in a venv — Ubuntu 24.04 blocks system-wide pip installs)

```bash
cd /home/kalshi/kalshi-arb
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 4. Bullpen CLI (Polymarket signal source)

The whale-following signals come from the Bullpen CLI. Install it to
`~/.bullpen/bin` and log in **interactively over SSH once** (it needs a browser/token
flow — it cannot be automated):

```bash
# follow Bullpen's install instructions, then:
bullpen login
bullpen status --output json   # smoke test — confirm logged_in: true
```

Whale-only mode (the bot's default) skips trading entirely if this isn't set up —
it fails loudly rather than silently falling back to a weaker signal source.

## 5. Verify (dry-run) before installing the services

```bash
cd /home/kalshi/kalshi-arb
.venv/bin/python3 scripts/run_bot.py --once            # one dry-run scan, check output
.venv/bin/python3 scripts/run_bot.py --once --paper    # one paper-trading scan
tail -f data/trades.jsonl                               # real-account decisions logged here
tail -f data/paper_trades.jsonl                          # paper decisions logged here
mkdir -p data/logs
```

## 6. Install the services (dry-run / paper first)

```bash
sudo cp deploy/kalshi-bot.service deploy/kalshi-papertrader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kalshi-bot kalshi-papertrader
systemctl status kalshi-bot kalshi-papertrader           # confirm running, no restarts
journalctl -u kalshi-bot -f                               # live logs (or -u kalshi-papertrader)
```

Both run continuously in the foreground (`run_bot.py` without `--once`), sleeping
`--interval` seconds between scans — `Restart=on-failure` is a safety net for
crashes, not the primary loop mechanism.

Let the real bot run **dry-run for ~24h**. Tail `data/trades.jsonl` and confirm the
opportunities, confidence scores, and sizing look sane. The paper trader is always
simulated — no burn-in risk, let it run indefinitely.

## 7. Go live (real bot only — paper trader never goes live)

Edit `/etc/systemd/system/kalshi-bot.service`, add `--live` to the `ExecStart`
line, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kalshi-bot
```

The bot keeps its dry-run-by-default safety: live trading only happens with the
explicit `--live` flag. Balance guard, per-trade cap, daily loss limit, and max
exposure cap all remain active. `kalshi-papertrader.service` ignores `--live`
entirely by design — `--paper` always forces simulation.

## Guardrails currently in effect (see ExecStart in each .service file)

| Guardrail            | Value | Flag |
|----------------------|-------|------|
| Max contracts/trade  | 5       | `--max-contracts` |
| Per-trade spend cap  | 10% of balance | `--per-trade-pct` |
| Max open exposure    | 30% of balance | `--max-exposure-pct` |
| Daily loss circuit-breaker | 20% of start-of-day balance | `--daily-loss-limit-pct` |
| Take-profit target   | entry × 1.15 (15% gross return) | `--take-profit-pct` |
| Stop-loss            | entry × 0.50 (50% below entry) | `--stop-loss-pct` |
| Market close window  | skip markets closing >12h out | `--max-hours-to-close` |
| Min market volume    | skip markets under $1,000,000 volume | `--min-market-volume` |

## Monitoring wins/losses

`data/trades.jsonl` (real) and `data/paper_trades.jsonl` (simulated) are the
ledgers — one JSON line per trade with confidence, entry price, and (after
settlement or an exit) `status` = `won`/`lost`/`closed` and `realized_pnl_cents`.
If `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are set in `.env`, every write also
mirrors to Supabase (`trades` / `portfolio_snapshots` tables, `paper` boolean
column distinguishes the two tracks) — that's what the dashboard reads from, so
it stays current without SSHing in.
