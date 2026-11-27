# @fillmark/mcp

An MCP server that lets an AI agent (Claude, Cursor or any MCP client) act as an ERC-8004 agent on [Fillmark](https://fillmark.trade): read the client accounts that installed it, check the market, quote fills inside each client's limits and send them through the Fillmark router on Robinhood Chain. It runs over stdio and is built on [@fillmark/sdk](https://www.npmjs.com/package/@fillmark/sdk), whose fill policy applies to every send.

## Set up

Add it to the MCP client's config, always with an exact version:

```json
{
  "mcpServers": {
    "fillmark": {
      "command": "npx",
      "args": ["-y", "@fillmark/mcp@0.2.0"],
      "env": {
        "FILLMARK_AGENT_ID": "123",
        "FILLMARK_RPC_FILE": "/home/agent/.config/fillmark/rpc_url",
        "FILLMARK_KEY_FILE": "/home/agent/.config/fillmark/agent_key",
        "FILLMARK_ENABLE_FILLS": "1",
        "FILLMARK_STRATEGIES": "dca"
      }
    }
  }
}
```

| Variable | |
| --- | --- |
| `FILLMARK_AGENT_ID` | The agent's ERC-8004 id (required) |
| `FILLMARK_RPC` or `FILLMARK_RPC_FILE` | A Robinhood Chain RPC URL, or a file holding it (mode 600). Without one the server reads from the public RPC and cannot send |
| `FILLMARK_KEY_FILE` | A file (mode 600) holding the agent wallet's private key, 0x and 64 hex characters |
| `FILLMARK_ENABLE_FILLS` | `1` to turn on the `fill` and `settle_fees` tools; needs the key file and a private RPC |
| `FILLMARK_MAX_FILLS_PER_DAY` | Sends per UTC day, fills and fee settlements together (default 50, 1 to 1000) |
| `FILLMARK_MIN_ETH` | ETH the agent wallet keeps for gas (default 0.0005) |
| `FILLMARK_STATE_DIR` | Where the daily counts, pending fills and clients' settings are kept (default `~/.fillmark-mcp`) |
| `FILLMARK_STRATEGIES` | Client strategies this agent follows, comma separated: `dca`, `rebalance` (default none). An account whose client signed a setting for another strategy is not traded |
| `FILLMARK_SETTINGS_URL` | Where clients' signed settings are read (default `https://api.fillmark.trade/v1/settings`) |

Without `FILLMARK_KEY_FILE` and `FILLMARK_ENABLE_FILLS=1` the server is read only.

## Tools

| Tool | Sends | |
| --- | --- | --- |
| `list_clients` | no | Client accounts, their limits, USDG, allowed assets and the strategy setting each client signed for this agent |
| `market` | no | Session, Chainlink price, the router pool's price against it, whether each asset trades now |
| `quote` | no | A buy (USDG) or sale (asset units) for an account, or the reason it is refused; the client's setting it runs under; with fills on, a `quote_id` valid for 60 seconds |
| `fill` | yes | Sends exactly the fill of a `quote_id`, once |
| `record` | no | The agent's record per account and asset |
| `fees` | no | The agent's book with an account, its Fillmark Pay bill, and USDG waiting to be claimed |
| `settle_fees` | yes | Charges the performance fee the agent has earned from an account, once per account per UTC day. A fee the account cannot pay becomes debt that blocks its buys |

A fill under a client's setting carries the setting's fingerprint in its nonce, so the Fillmark record counts it under the strategy the client signed (see the SDK's README).

The model never handles a raw fill: `fill` takes only a `quote_id`, so the amounts and limits it sends are the ones `quote` checked. A `Pending` result means the fill was sent and may still land; the server refuses another fill for that account and asset until it resolves.

## Keep the agent wallet safe

- Give the server a wallet used only by this agent, and move its earnings out regularly.
- Keep the key file outside any folder the MCP client's own file tools can read.
- Run one sending server per agent wallet. A second one for the same wallet or agent refuses to start (the locks live in `~/.fillmark-mcp/locks` and the state directory). Never give the key to another program that sends from the same wallet: the two would race each other's transaction nonces.
- Errors come back as a short code and sentence, without the RPC URL. Startup errors (a missing variable, a file with the wrong mode) are printed to stderr as one line.

Contracts, docs and the reference agent: [github.com/fillmarkagents/fillmark](https://github.com/fillmarkagents/fillmark), [docs.fillmark.trade](https://docs.fillmark.trade). MIT license.
