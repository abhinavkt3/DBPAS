package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// SmartContract mirrors the revised DBPAS checkpoint model for Fabric deployments.
type SmartContract struct {
	contractapi.Contract
}

// ProductAsset is the on-ledger lifecycle asset for one physical product unit.
type ProductAsset struct {
	ID             string   `json:"id"`
	Metadata       string   `json:"metadata"`
	CurrentNonce   string   `json:"currentNonce"`
	GPSDestHash    string   `json:"gpsDestHash"`
	MinTransitTime uint64   `json:"minTransitTime"`
	Owner          string   `json:"owner"`
	Consumed       bool     `json:"consumed"`
	TransferCount  uint16   `json:"transferCount"`
	OwnerHistory   []string `json:"ownerHistory"`
}

type checkpointEvent struct {
	TokenID  string `json:"tokenId"`
	From     string `json:"from"`
	To       string `json:"to"`
	NewNonce string `json:"newNonce"`
}

// RegisterProduct mirrors the revised paper contract surface by accepting the
// initial GNQR nonce, destination hash, and minimum transit time directly.
func (s *SmartContract) RegisterProduct(
	ctx contractapi.TransactionContextInterface,
	pid string,
	meta string,
	initialNonce string,
	gpsDestHash string,
	minTransitTime uint64,
) error {
	clientID, err := s.clientID(ctx)
	if err != nil {
		return err
	}

	if pid == "" {
		return fmt.Errorf("product id is required")
	}
	if initialNonce == "" {
		return fmt.Errorf("initial nonce is required")
	}
	if gpsDestHash == "" {
		return fmt.Errorf("gps destination hash is required")
	}

	asset := ProductAsset{
		ID:             pid,
		Metadata:       meta,
		CurrentNonce:   initialNonce,
		GPSDestHash:    gpsDestHash,
		MinTransitTime: minTransitTime,
		Owner:          clientID,
		Consumed:       false,
		TransferCount:  0,
		OwnerHistory:   []string{clientID},
	}

	payload, err := json.Marshal(asset)
	if err != nil {
		return err
	}

	return ctx.GetStub().PutState(pid, payload)
}

// AtomicCheckpoint keeps nonce evolution and ownership transfer inseparable.
func (s *SmartContract) AtomicCheckpoint(
	ctx contractapi.TransactionContextInterface,
	pid string,
	newOwner string,
	newNonce string,
	newGPSDestHash string,
	newMinTransit uint64,
) error {
	asset, err := s.getAsset(ctx, pid)
	if err != nil {
		return err
	}

	if err := s.verifyOwner(ctx, asset); err != nil {
		return err
	}

	if newOwner == "" {
		return fmt.Errorf("new owner is required")
	}
	if newOwner == asset.Owner {
		return fmt.Errorf("new owner must differ from current owner")
	}
	if newNonce == "" {
		return fmt.Errorf("new nonce is required")
	}
	if newGPSDestHash == "" {
		return fmt.Errorf("gps destination hash is required")
	}

	previousOwner := asset.Owner
	asset.CurrentNonce = newNonce
	asset.GPSDestHash = newGPSDestHash
	asset.MinTransitTime = newMinTransit
	asset.Consumed = false
	asset.Owner = newOwner
	asset.TransferCount += 1
	asset.OwnerHistory = append(asset.OwnerHistory, newOwner)

	if err := s.putAsset(ctx, asset); err != nil {
		return err
	}

	eventPayload, err := json.Marshal(checkpointEvent{
		TokenID:  pid,
		From:     previousOwner,
		To:       newOwner,
		NewNonce: newNonce,
	})
	if err != nil {
		return err
	}

	return ctx.GetStub().SetEvent("CheckpointAtomic", eventPayload)
}

// UpdateNonce is intentionally disabled in the revised model because the paper
// now enforces nonce plus ownership atomicity.
func (s *SmartContract) UpdateNonce(
	ctx contractapi.TransactionContextInterface,
	pid string,
	gpsNow string,
	gpsDest string,
) error {
	return fmt.Errorf("deprecated in revised DBPAS: use AtomicCheckpoint")
}

// TransferOwnership is intentionally disabled in the revised model because raw
// ownership moves would violate the atomic checkpoint invariant.
func (s *SmartContract) TransferOwnership(
	ctx contractapi.TransactionContextInterface,
	pid string,
	newOwner string,
) error {
	return fmt.Errorf("deprecated in revised DBPAS: use AtomicCheckpoint")
}

// VerifyProduct returns 0 = AUTHENTIC, 1 = CLONE_ALERT, 2 = TAMPERED.
func (s *SmartContract) VerifyProduct(
	ctx contractapi.TransactionContextInterface,
	pid string,
	claimed string,
) (uint8, error) {
	asset, err := s.getAsset(ctx, pid)
	if err != nil {
		return 0, err
	}

	if asset.Consumed {
		if eventErr := ctx.GetStub().SetEvent("CLONE_ALERT", []byte(pid)); eventErr != nil {
			return 0, eventErr
		}
		return 1, nil
	}

	if asset.CurrentNonce != claimed {
		return 2, nil
	}

	asset.Consumed = true
	if err := s.putAsset(ctx, asset); err != nil {
		return 0, err
	}

	return 0, nil
}

func (s *SmartContract) ReadProduct(
	ctx contractapi.TransactionContextInterface,
	pid string,
) (*ProductAsset, error) {
	return s.getAsset(ctx, pid)
}

func (s *SmartContract) GetOwnerHistory(
	ctx contractapi.TransactionContextInterface,
	pid string,
) ([]string, error) {
	asset, err := s.getAsset(ctx, pid)
	if err != nil {
		return nil, err
	}

	return asset.OwnerHistory, nil
}

func (s *SmartContract) getAsset(
	ctx contractapi.TransactionContextInterface,
	pid string,
) (*ProductAsset, error) {
	raw, err := ctx.GetStub().GetState(pid)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("product %s not found", pid)
	}

	var asset ProductAsset
	if err := json.Unmarshal(raw, &asset); err != nil {
		return nil, err
	}

	return &asset, nil
}

func (s *SmartContract) putAsset(
	ctx contractapi.TransactionContextInterface,
	asset *ProductAsset,
) error {
	payload, err := json.Marshal(asset)
	if err != nil {
		return err
	}

	return ctx.GetStub().PutState(asset.ID, payload)
}

func (s *SmartContract) verifyOwner(
	ctx contractapi.TransactionContextInterface,
	asset *ProductAsset,
) error {
	clientID, err := s.clientID(ctx)
	if err != nil {
		return err
	}

	if asset.Owner != clientID {
		return fmt.Errorf("caller %s is not current owner of %s", clientID, asset.ID)
	}

	return nil
}

func (s *SmartContract) clientID(ctx contractapi.TransactionContextInterface) (string, error) {
	return ctx.GetClientIdentity().GetID()
}

func hashString(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}

func main() {
	chaincode, err := contractapi.NewChaincode(&SmartContract{})
	if err != nil {
		panic(fmt.Sprintf("failed to create DBPAS chaincode: %v", err))
	}

	if err := chaincode.Start(); err != nil {
		panic(fmt.Sprintf("failed to start DBPAS chaincode: %v", err))
	}
}
