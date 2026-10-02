# Soccerverse Subgraph

This repository defines a ["The Graph" subgraphs](https://thegraph.com/)
that processes some events of the Soccerverse smart contracts.  In particular,
we process events and index data about:

- Referrals for the referral leaderboard
- Minted club influence to provide easily accessible, preindexed data
  about influence packs for the shop

Full-tier pack refreshes batch contract reads through Polygon's existing
[Multicall3](https://github.com/mds1/multicall3) deployment at
`0xcA11bde05977b3631167028862bE2a173976CA11` (block 25770160, before
`PACK_START_HEIGHT`). Each group of at most 25 clubs needs one availability
read and, if any packs are available, one preview read. The sale contract still
calculates availability, prices and contents at the indexed block. A failed
read fails the refresh; it never becomes an unavailable pack.

To generate bindings, build and run the mapping tests:

```
npm ci
npx graph codegen
npx graph build
npx graph test -v 0.6.0
```

Mapping changes require a new subgraph deployment and replay, or a compatible
graft. Before production use, compare complete entities at identical block hashes
and measure refresh time and RPC limits with the intended historical provider;
unit tests do not measure end-to-end indexing performance.
