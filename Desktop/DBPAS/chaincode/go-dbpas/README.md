# DBPAS Go Chaincode

This package now mirrors the revised DBPAS checkpoint model for Hyperledger Fabric:

- `RegisterProduct`
- `AtomicCheckpoint`
- `VerifyProduct`
- `ReadProduct`
- `GetOwnerHistory`

The previous standalone `UpdateNonce` and `TransferOwnership` operations are intentionally deprecated here because the revised paper enforces nonce plus ownership atomicity.

The primary revised-paper contract is now the Solidity implementation under [chaincode/solidity-dbpas/DBPASProduct.sol](/Users/abhinavthakur/Desktop/Sandbox2/chaincode/solidity-dbpas/DBPASProduct.sol). The local web app still runs against a Fabric-style simulation so it can work without a full Hyperledger Fabric runtime, and this Go file remains as the Fabric-oriented mirror for later deployment.

To wire this into a real Fabric network, add a standard Go module for `fabric-contract-api-go`, package the chaincode, and deploy it on the relevant channel.
