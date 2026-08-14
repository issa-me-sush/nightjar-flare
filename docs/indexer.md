# Running your own indexer

The FCC extension proxy reads Flare signing policies from an indexer database.
The scaffold's default configuration points at Flare's internal indexer at
`35.241.249.150:3306`, which needs VPN access or credentials from the Flare
team.

You do not have to wait for those. Flare's C-chain indexer is open source, and
in FSP mode it indexes exactly what the proxy needs, from the public Coston2
RPC.

## Setup

```bash
# 1. A database for it to write to
docker run -d --name flare-indexer-mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=flare_ftso_indexer \
  -p 3306:3306 mysql:8

# 2. Build the indexer
git clone https://github.com/flare-foundation/flare-system-c-chain-indexer.git
cd flare-system-c-chain-indexer
go build -o /tmp/flare-cchain-indexer ./cmd/...

# 3. Run it against Coston2
/tmp/flare-cchain-indexer --config indexer-coston2.toml
```

## Config

The one setting that is not obvious:

```toml
log_range = 30
```

**The public Coston2 RPC caps `eth_getLogs` at 30 blocks.** The indexer's
default is 1000, which fails with:

```
requested too many blocks from 33799414 to 33800413, maximum is set to 30
```

The failure is easy to miss because the indexer retries with backoff and looks
alive while inserting nothing. If rows never appear in `logs`, this is why.

```toml
[indexer]
mode = "fsp"            # only what the FSP stack needs; fast startup
history_epochs = 0      # last ~15 minutes of blocks
log_range = 30          # the public RPC's getLogs cap
rpc_concurrency = 20
batch_size = 200

[chain]
node_url = "https://coston2-api.flare.network/ext/C/rpc"
chain_type = 1

[db]
host = "localhost"
port = 3306
database = "flare_ftso_indexer"
username = "root"
password = "root"
```

FSP mode resolves contract addresses by name through the onchain
`ContractRegistry`, so nothing network-specific needs hardcoding.

## Pointing the proxy at it

In `config/proxy/extension_proxy.coston2.docker.toml`:

```toml
[db]
host = "host.docker.internal"   # the proxy is containerised; MySQL is on the host
port = 3306
database = "flare_ftso_indexer"
username = "root"
password = "root"
```

## Verifying

```bash
docker exec flare-indexer-mysql mysql -uroot -proot -N \
  -e "use flare_ftso_indexer; select count(*) from logs;"
```

Startup backfills FSP metadata events (signing policies, voter registrations)
from two reward epochs back, then follows the chain head. The backfill takes a
few minutes on the public endpoint; look for:

```
FSP event indexing completed: from=..., to=..., inserted=85
```

Once `logs` is growing and that line has appeared, the proxy has what it needs.
