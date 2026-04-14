import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { DBPASService } from "../src/dbpas-service.mjs";

function createService() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbpas-test-"));
  const dbFile = path.join(tempDir, "ledger.json");
  return new DBPASService({
    dbFile,
    secret: "dbpas-secure-local-runtime"
  });
}

function login(service, username, password) {
  return service.login({ username, password }).token;
}

function createStakeholder(service, adminToken, input) {
  return service.createAccount(adminToken, {
    displayName: input.displayName,
    username: input.username,
    password: input.password,
    email: input.email ?? `${input.username}@example.com`,
    role: input.role,
    postSaleOrdinal: input.postSaleOrdinal,
    registeredGps: input.registeredGps
  }).account;
}

test("bootstraps a clean instance with only the admin account", () => {
  const service = createService();
  const bootstrap = service.getPublicBootstrap();

  assert.equal(bootstrap.stats.accounts, 1);
  assert.equal(bootstrap.stats.products, 0);
  assert.deepEqual(bootstrap.auth.setupHint, {
    username: "admin",
    password: "admin123"
  });
});

test("allows the bootstrap admin to create stakeholder accounts", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });

  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });

  assert.equal(manufacturer.role, "manufacturer");
  assert.equal(distributor.role, "distributor");

  const dashboard = service.getDashboard(adminToken);
  assert.equal(dashboard.accounts.length, 3);
});

test("allows each stakeholder to create the next stakeholder in the chain, including post-sale owners", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributor = createStakeholder(service, manufacturerToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });

  const distributorToken = login(service, distributor.username, "secret123");
  const retailer = createStakeholder(service, distributorToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const retailerToken = login(service, retailer.username, "secret123");
  const firstOwner = createStakeholder(service, retailerToken, {
    displayName: "Priya Sharma",
    username: "priya-owner",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const firstOwnerToken = login(service, firstOwner.username, "secret123");
  const secondOwner = createStakeholder(service, firstOwnerToken, {
    displayName: "Arjun Verma",
    username: "arjun-owner",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  assert.equal(distributor.role, "distributor");
  assert.equal(retailer.role, "retailer");
  assert.equal(firstOwner.roleLabel, "1st Owner");
  assert.equal(secondOwner.roleLabel, "2nd Owner");

  const firstOwnerDashboard = service.getDashboard(firstOwnerToken);
  assert.equal(firstOwnerDashboard.stakeholderCreation.options[0].roleLabel, "2nd Owner");
});

test("supports manufacturer to retailer supply-chain flow with GNQR validation", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");

  service.registerProduct(manufacturerToken, {
    productId: "dbpas-device-001",
    productName: "DBPAS Device",
    batchNumber: "APX-01",
    manufacturingDate: "2026-04-02",
    description: "Tracked device",
    category: "Electronics",
    destinationAccountId: distributor.id,
    gpsFactory: { lat: 28.7041, lon: 77.1025 }
  });

  service.handoffProduct(manufacturerToken, "dbpas-device-001", {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id,
    gpsNow: { lat: 28.7041, lon: 77.1025 }
  });

  service.handoffProduct(distributorToken, "dbpas-device-001", {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id,
    gpsNow: { lat: 26.9124, lon: 75.7873 }
  });

  const detail = service.getProductDetails(retailerToken, "dbpas-device-001");
  assert.equal(detail.audit.status, "AUTHENTIC");
  assert.equal(detail.product.ownerAccountId, retailer.id);
  assert.equal(detail.product.checkpointIndex, 2);
  assert.equal(detail.product.transferCount, 2);
  assert.equal(typeof detail.product.gpsDestHashPreview, "string");
  assert.match(detail.product.qrImageDataUrl, /^data:image\/svg\+xml/);
});

test("keeps the manufacturer QR image fixed while the GNQR payload changes at each checkpoint", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");

  const registration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-device-qr-dynamic",
    productName: "DBPAS Device",
    batchNumber: "APX-QR",
    manufacturingDate: "2026-04-02",
    description: "Dynamic GNQR test device",
    category: "Electronics",
    destinationAccountId: distributor.id,
    gpsFactory: { lat: 28.7041, lon: 77.1025 }
  });

  const registrationPayload = JSON.parse(registration.product.qrPayload);
  assert.match(registration.product.qrImageDataUrl, /^data:image\/svg\+xml/);
  assert.equal(
    registration.product.manufacturerQrPayload,
    `https://dbpas.io/verify?pid=dbpas-device-qr-dynamic&t=${encodeURIComponent(registration.product.token)}`
  );
  assert.deepEqual(registrationPayload.currentLocation, { lat: 28.7041, lon: 77.1025 });
  assert.deepEqual(registrationPayload.destinationLocation, { lat: 26.9124, lon: 75.7873 });

  service.handoffProduct(manufacturerToken, registration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id,
    gpsNow: { lat: 28.5355, lon: 77.391 }
  });

  const distributorDetail = service.getProductDetails(distributorToken, registration.product.id);
  const distributorPayload = JSON.parse(distributorDetail.product.qrPayload);
  assert.equal(distributorDetail.product.qrImageDataUrl, registration.product.qrImageDataUrl);
  assert.equal(distributorDetail.product.manufacturerQrPayload, registration.product.manufacturerQrPayload);
  assert.notEqual(distributorDetail.product.qrPayload, registration.product.qrPayload);
  assert.notEqual(distributorPayload.nonce, registrationPayload.nonce);
  assert.deepEqual(distributorPayload.currentLocation, { lat: 28.5355, lon: 77.391 });
  assert.deepEqual(distributorPayload.destinationLocation, { lat: 19.076, lon: 72.8777 });

  service.handoffProduct(distributorToken, registration.product.id, {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id,
    gpsNow: { lat: 26.9124, lon: 75.7873 }
  });

  const retailerDetail = service.getProductDetails(retailerToken, registration.product.id);
  const retailerPayload = JSON.parse(retailerDetail.product.qrPayload);
  assert.equal(retailerDetail.product.qrImageDataUrl, registration.product.qrImageDataUrl);
  assert.equal(retailerDetail.product.manufacturerQrPayload, registration.product.manufacturerQrPayload);
  assert.notEqual(retailerDetail.product.qrPayload, distributorDetail.product.qrPayload);
  assert.notEqual(retailerPayload.nonce, distributorPayload.nonce);
  assert.deepEqual(retailerPayload.currentLocation, { lat: 26.9124, lon: 75.7873 });
  assert.deepEqual(retailerPayload.destinationLocation, { lat: 19.076, lon: 72.8777 });
});

test("supports custom destination GPS overrides across registration, handoff, and owner transfer", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });
  const consumer = createStakeholder(service, adminToken, {
    displayName: "Remote Owner",
    username: "remote-owner",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 28.6139, lon: 77.209 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");
  const consumerToken = login(service, consumer.username, "secret123");

  const defaultRegistration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-device-default-route",
    productName: "DBPAS Device",
    batchNumber: "APX-05",
    manufacturingDate: "2026-04-02",
    description: "Default routing reference",
    category: "Electronics",
    destinationAccountId: distributor.id
  });

  const customRegistration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-device-custom-route",
    productName: "DBPAS Device",
    batchNumber: "APX-06",
    manufacturingDate: "2026-04-02",
    description: "Custom routing reference",
    category: "Electronics",
    destinationAccountId: distributor.id,
    destinationGps: { lat: 27.1751, lon: 78.0421 }
  });

  assert.notEqual(
    defaultRegistration.product.gpsDestHashPreview,
    customRegistration.product.gpsDestHashPreview
  );

  service.handoffProduct(manufacturerToken, defaultRegistration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id,
    gpsNow: manufacturer.registeredGps
  });
  service.handoffProduct(manufacturerToken, customRegistration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id,
    gpsNow: manufacturer.registeredGps,
    destinationGps: { lat: 18.9402, lon: 72.8356 }
  });

  const defaultHandoffDetail = service.getProductDetails(distributorToken, defaultRegistration.product.id);
  const customHandoffDetail = service.getProductDetails(distributorToken, customRegistration.product.id);
  assert.notEqual(
    defaultHandoffDetail.product.gpsDestHashPreview,
    customHandoffDetail.product.gpsDestHashPreview
  );

  service.handoffProduct(distributorToken, customRegistration.product.id, {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id,
    gpsNow: distributor.registeredGps
  });

  const customSaleDestination = { lat: 19.2183, lon: 72.9781 };
  service.transferOwnership(retailerToken, customRegistration.product.id, {
    receiverAccountId: consumer.id,
    gpsNow: customSaleDestination,
    destinationGps: customSaleDestination
  });

  const verification = service.verifyProduct(consumerToken, customRegistration.product.id, {
    token: customRegistration.product.token,
    scanLocation: customSaleDestination
  });
  assert.equal(verification.report.status, "AUTHENTIC");
});

test("supports atomic retailer sale and clone alert on repeated verification", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });
  const consumerA = createStakeholder(service, adminToken, {
    displayName: "Priya Sharma",
    username: "priya-consumer",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");
  const consumerAToken = login(service, consumerA.username, "secret123");

  const registration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-watch-002",
    productName: "DBPAS Watch",
    batchNumber: "APX-02",
    manufacturingDate: "2026-04-02",
    description: "Luxury watch",
    category: "Luxury Goods",
    destinationAccountId: distributor.id
  });

  service.handoffProduct(manufacturerToken, registration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id
  });
  service.handoffProduct(distributorToken, registration.product.id, {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id
  });

  service.transferOwnership(retailerToken, registration.product.id, {
    receiverAccountId: consumerA.id,
    gpsNow: { lat: 19.076, lon: 72.8777 }
  });

  const owned = service.getDashboard(consumerAToken).products.find(
    (product) => product.id === registration.product.id
  );
  assert.equal(owned.ownerAccountId, consumerA.id);
  assert.equal(owned.checkpointIndex, 3);
  assert.equal(owned.transferCount, 3);

  const firstCheck = service.verifyProduct(consumerAToken, registration.product.id, {
    token: registration.product.token,
    scanLocation: { lat: 19.076, lon: 72.8777 }
  });
  assert.equal(firstCheck.report.status, "AUTHENTIC");

  const replayCheck = service.verifyProduct(consumerAToken, registration.product.id, {
    token: registration.product.token,
    scanLocation: { lat: 19.076, lon: 72.8777 }
  });
  assert.equal(replayCheck.report.status, "CLONE_ALERT");
});

test("blocks early verification when the GPS-time transit bound has not elapsed", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });
  const consumer = createStakeholder(service, adminToken, {
    displayName: "Far Buyer",
    username: "far-buyer",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 28.6139, lon: 77.209 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");
  const consumerToken = login(service, consumer.username, "secret123");

  const registration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-bag-003",
    productName: "DBPAS Bag",
    batchNumber: "APX-03",
    manufacturingDate: "2026-04-02",
    description: "Tracked bag",
    category: "Luxury Goods",
    destinationAccountId: distributor.id
  });

  service.handoffProduct(manufacturerToken, registration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id
  });
  service.handoffProduct(distributorToken, registration.product.id, {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id
  });
  service.transferOwnership(retailerToken, registration.product.id, {
    receiverAccountId: consumer.id,
    gpsNow: { lat: 19.076, lon: 72.8777 }
  });

  const earlyCheck = service.verifyProduct(consumerToken, registration.product.id, {
    token: registration.product.token,
    scanLocation: { lat: 28.6139, lon: 77.209 }
  });

  assert.equal(earlyCheck.report.status, "TAMPERED");
  assert.equal(earlyCheck.report.checks[3].ok, false);
});

test("supports atomic consumer-to-consumer transfer with a fresh nonce window", () => {
  const service = createService();
  const adminToken = login(service, "admin", "admin123");

  const manufacturer = createStakeholder(service, adminToken, {
    displayName: "Apex Plant",
    username: "apex-manufacturer",
    password: "secret123",
    role: "manufacturer",
    registeredGps: { lat: 28.7041, lon: 77.1025 }
  });
  const distributor = createStakeholder(service, adminToken, {
    displayName: "North Hub",
    username: "north-distributor",
    password: "secret123",
    role: "distributor",
    registeredGps: { lat: 26.9124, lon: 75.7873 }
  });
  const retailer = createStakeholder(service, adminToken, {
    displayName: "Mumbai Store",
    username: "mumbai-retailer",
    password: "secret123",
    role: "retailer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });
  const consumerA = createStakeholder(service, adminToken, {
    displayName: "Priya Sharma",
    username: "priya-consumer",
    password: "secret123",
    role: "consumer",
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });
  const consumerB = createStakeholder(service, adminToken, {
    displayName: "Arjun Verma",
    username: "arjun-consumer",
    password: "secret123",
    role: "consumer",
    postSaleOrdinal: 2,
    registeredGps: { lat: 19.076, lon: 72.8777 }
  });

  const manufacturerToken = login(service, manufacturer.username, "secret123");
  const distributorToken = login(service, distributor.username, "secret123");
  const retailerToken = login(service, retailer.username, "secret123");
  const consumerAToken = login(service, consumerA.username, "secret123");
  const consumerBToken = login(service, consumerB.username, "secret123");

  const registration = service.registerProduct(manufacturerToken, {
    productId: "dbpas-watch-004",
    productName: "DBPAS Watch",
    batchNumber: "APX-04",
    manufacturingDate: "2026-04-02",
    description: "Luxury watch",
    category: "Luxury Goods",
    destinationAccountId: distributor.id
  });

  service.handoffProduct(manufacturerToken, registration.product.id, {
    receiverAccountId: distributor.id,
    destinationAccountId: retailer.id
  });
  service.handoffProduct(distributorToken, registration.product.id, {
    receiverAccountId: retailer.id,
    destinationAccountId: retailer.id
  });
  service.transferOwnership(retailerToken, registration.product.id, {
    receiverAccountId: consumerA.id,
    gpsNow: { lat: 19.076, lon: 72.8777 }
  });

  const firstOwnerCheck = service.verifyProduct(consumerAToken, registration.product.id, {
    token: registration.product.token,
    scanLocation: { lat: 19.076, lon: 72.8777 }
  });
  assert.equal(firstOwnerCheck.report.status, "AUTHENTIC");

  service.transferOwnership(consumerAToken, registration.product.id, {
    receiverAccountId: consumerB.id,
    gpsNow: { lat: 19.076, lon: 72.8777 }
  });

  const dashboard = service.getDashboard(consumerBToken);
  const owned = dashboard.products.find((product) => product.id === registration.product.id);
  assert.equal(owned.ownerAccountId, consumerB.id);
  assert.equal(owned.transferCount, 4);

  const secondOwnerCheck = service.verifyProduct(consumerBToken, registration.product.id, {
    token: registration.product.token,
    scanLocation: { lat: 19.076, lon: 72.8777 }
  });
  assert.equal(secondOwnerCheck.report.status, "AUTHENTIC");
});
