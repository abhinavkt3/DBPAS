# DBPAS Solidity Contract

This folder contains the revised-paper Solidity reference contract:

- [DBPASProduct.sol](/Users/abhinavthakur/Desktop/Sandbox2/chaincode/solidity-dbpas/DBPASProduct.sol)

It implements the newer contract model from the updated paper:

- atomic nonce plus ownership checkpoints through `atomicCheckpoint`
- destination-hash and minimum-transit-time storage on-chain
- one-time nonce consumption with `verifyProduct`
- continuous provenance through `ownerHistory`
- ERC-721 style ownership semantics with direct public transfers disabled so the atomicity invariant cannot be bypassed

Local verification can be done with:

```bash
npx solc --standard-json
```

The web app still runs on the local Fabric-style simulation in this repo, but this Solidity contract is now the primary chain-level reference for the revised paper.
