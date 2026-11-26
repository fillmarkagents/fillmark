# Security

## Reporting a vulnerability

Report it privately on GitHub: open the Security tab of this repository and choose
"Report a vulnerability", or go to
[github.com/fillmarkagents/fillmark/security/advisories/new](https://github.com/fillmarkagents/fillmark/security/advisories/new).
Please don't open a public issue or post about it while it is being handled.

A useful report names the contract or package, says what an attacker can do and to whom,
and shows how to reproduce it, ideally as a Foundry test on a fork of Robinhood Chain
(chain id 4663). Test on a fork or a local chain, never against live client accounts.

## Scope

- The deployed contracts listed under Deployment in the [README](README.md): the three
  routers, FillmarkFeeds, FillmarkBurner and FillmarkPay, with the Safe, timelock and
  guardian roles set on them.
- The reference agent (`agent/`), the record library (`record/`), the TypeScript SDK
  (`sdk/`) and the MCP server (`mcp/`).

Issues in fillmark.trade, app.fillmark.trade, docs.fillmark.trade, api.fillmark.trade or
rpc.fillmark.trade can be reported the same way, though their code is not in this
repository.

## Fixes

No Fillmark contract can be upgraded, and router v1 and Pay have no admin at all. The others
can be changed only in the limited ways the README lists for the Safe, through the 2-day
timelock, and for the guardian. An issue in a deployed contract is handled with those
powers or in the tools around it: the client app, the SDK and the reference agent.

There is no bug bounty program.
