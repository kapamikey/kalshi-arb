# Deploying the Kalshi bot on a VM

The bot is I/O-bound (HTTP polling), so the cheapest small always-on VM is plenty.
Recommended: **DigitalOcean droplet, 1 vCPU / 1 GB RAM, Ubuntu 24.04 (~$6/mo)**. Any
equivalent (Hetzner, Lightsail, Vultr) works the same way.

## 1. Provision & secure

```bash
# On the droplet, as root:
adduser --disabled-password --gecos "" kalshi
ufw allow OpenSSH        # SSH inbound only — the bot only makes outbound HTTPS
ufw --force enable
apt update && apt install -y python3 python3-pip git
```

## 2. Copy the project + secrets (out-of-band, NOT via git)

The private key and `.env` must never be committed. Copy them directly:

```bash
# From your Mac:
rsync -av --exclude data/logs --exclude __pycache__ \
    ~/Desktop/1-Projects/kalshi-arb/ kalshi@YOUR_VM_IP:/home/kalshi/kalshi-arb/
scp ~/Desktop/1-Projects/kalshi-arb/.env               kalshi@YOUR_VM_IP:/home/kalshi/kalshi-arb/.env
scp ~/Desktop/1-Projects/kalshi-arb/config/kalshi-private-key.pem \
    kalshi@YOUR_VM_IP:/home/kalshi/kalshi-arb/config/kalshi-private-key.pem
```

On the VM, confirm `KALSHI_PRIVATE_KEY_PATH` in `.env` points at
`/home/kalshi/kalshi-arb/config/kalshi-private-key.pem` and lock the key down:

```bash
chmod 600 /home/kalshi/kalshi-arb/config/kalshi-private-key.pem
```

## 3. Install dependencies

```bash
cd /home/kalshi/kalshi-arb
pip3 install -r requirements.txt
```

## 4. Bullpen CLI (Polymarket signal source)

The whale-following signals come from the Bullpen CLI. Install it to
`~/.bullpen/bin` and log in **interactively over SSH once** (it needs a browser/token
flow — it cannot be automated):

```bash
# follow Bullpen's install instructions, then:
bullpen login
bullpen polymarket data leaderboard --limit 3 --output json   # smoke test
```

If Bullpen isn't installed, the bot still runs — it just produces no whale signals
and trades only on the internal mispricing scan.

## 5. Verify (dry-run) before going live

```bash
cd /home/kalshi/kalshi-arb
python3 scripts/run_bot.py --once        # one dry-run scan, check output + ledger
tail -f data/trades.jsonl                # decisions get logged here
```

## 6. Install the service (dry-run first)

```bash
sudo cp deploy/kalshi-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kalshi-bot
systemctl status kalshi-bot              # confirm running, no restarts
journalctl -u kalshi-bot -f              # live logs
```

Let it run **dry-run for ~24h**. Tail `data/trades.jsonl` and confirm the
opportunities, confidence scores, and sizing look sane.

## 7. Go live

Edit `/etc/systemd/system/kalshi-bot.service`, add `--live` to the `ExecStart`
line, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kalshi-bot
```

The bot keeps its dry-run-by-default safety: live trading only happens with the
explicit `--live` flag. Balance guard, per-trade cap, daily loss limit, and max
exposure cap all remain active.

## Guardrails in effect (defaults)

| Guardrail            | Default | Flag |
|----------------------|---------|------|
| Max contracts/trade  | 5       | `--max-contracts` |
| Per-trade spend cap  | 10% of balance | `--per-trade-pct` |
| Max open exposure    | 50% of balance | `--max-exposure-pct` |
| Daily loss circuit-breaker | 20% of start-of-day balance | `--daily-loss-limit-pct` |
| Take-profit target   | entry × 1.20 (20% gross return) | `--take-profit-pct` |
| Stop-loss            | entry × 0.50 (50% below entry) | `--stop-loss-pct` |

## Monitoring wins/losses

`data/trades.jsonl` is the ledger — one JSON line per trade with confidence,
entry price, and (after settlement) `status` = `won`/`lost` and `realized_pnl_cents`.
The bot logs a running W/L summary each cycle once trades start settling.
