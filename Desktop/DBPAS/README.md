# DBPAS Revised App

This repository implements a clean multi-account DBPAS application aligned to the revised paper:

> *DBPAS: A Geo-Nonce Authenticated, Atomically-Consistent Blockchain Framework for End-to-End Anti-Counterfeit Detection Across Pre- and Post-Supply-Chain Lifecycles*

## What changed

- Removed the seeded demo products and example stakeholder flow from the app runtime
- Added an admin-controlled account system for:
  - manufacturer
  - distributor
  - retailer
  - consumer
- Added separate role-specific panels for each stakeholder
- Secured product actions behind authenticated sessions instead of free-form wallet selection in the UI
- Added downstream stakeholder creation so each stakeholder can create the next role in the supply chain
- Added explicit post-sale owner stages such as 1st Owner, 2nd Owner, 3rd Owner, and onward
- Upgraded the GNQR flow to the revised paper model:
  - atomic nonce plus ownership checkpoints
  - GPS destination hash tracking
  - minimum transit-time bound enforcement
  - replay and replay-forward resistance checks
- Added browser GPS auto-detection buttons for form-based checkpoint entry
- Replaced the placeholder QR visual with a real generated, downloadable QR code

## Bootstrap access

The app starts with one clean admin account and no sample products:

- Username: `admin`
- Password: `admin123`

Use the admin panel to create all other stakeholder accounts before running the supply-chain workflow.

## Run it

```bash
npm start
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000). If `3000` is busy, the app automatically retries on `3001`.

## Test it

```bash
npm test
```

This now includes a real Solidity compilation pass for the revised-paper contract under [chaincode/solidity-dbpas/DBPASProduct.sol](/Users/abhinavthakur/Desktop/Sandbox2/chaincode/solidity-dbpas/DBPASProduct.sol).

## Included capabilities

- Admin governance for stakeholder creation and activation status
- Manufacturer-created distributors, distributor-created retailers, retailer-created 1st Owners, and owner-created downstream owners
- Manufacturer product registration with GNQR minting and transit-bound initialization
- Real QR code generation at product registration, with download support in the UI
- Distributor logistics handoff with atomic nonce and ownership updates
- Retailer sale checkpoints that advance nonce and ownership together
- Consumer ownership verification and secondary-market atomic transfer
- GNQR audit and verification backed by the local Fabric-style ledger simulation

## Fabric note

The web app runs on a local Fabric-style simulation so it can work in this environment without a full Hyperledger Fabric deployment.

- The revised-paper primary contract is the Solidity implementation under [chaincode/solidity-dbpas/README.md](/Users/abhinavthakur/Desktop/Sandbox2/chaincode/solidity-dbpas/README.md).
- The Fabric-oriented Go mirror is still included under [chaincode/go-dbpas/README.md](/Users/abhinavthakur/Desktop/Sandbox2/chaincode/go-dbpas/README.md).
