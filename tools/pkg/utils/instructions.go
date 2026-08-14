package utils

import (
	"context"
	"os"
	"math/big"
	"time"

	"extension-scaffold/tools/pkg/contracts/nightjarauction"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/pkg/errors"
)

func DeployInstructionSender(s *support.Support) (common.Address, *nightjarauction.NightjarAuction, error) {
	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to create transactor: %s", err)
	}

	// Both registry args are the FlareTeeManager diamond proxy: the diamond
	// routes ExtensionManager and MachineManager calls to the right facets.
	baseToken := common.HexToAddress(os.Getenv("BASE_TOKEN"))
	quoteToken := common.HexToAddress(os.Getenv("QUOTE_TOKEN"))
	if baseToken == (common.Address{}) || quoteToken == (common.Address{}) {
		return common.Address{}, nil, errors.New("BASE_TOKEN and QUOTE_TOKEN must be set")
	}

	address, tx, contract, err := nightjarauction.DeployNightjarAuction(
		opts, s.ChainClient, s.Addresses.FlareTeeManager, s.Addresses.FlareTeeManager,
		baseToken, quoteToken,
	)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("failed to deploy contract: %s", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		return common.Address{}, nil, errors.Errorf("deployment tx not mined within 2 minutes (tx: %s): %s", tx.Hash().Hex(), err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		return common.Address{}, nil, errors.New("contract deployment failed")
	}

	return address, contract, nil
}

func SetExtensionId(s *support.Support, instructionSenderAddress common.Address) error {
	sender, err := nightjarauction.NewNightjarAuction(instructionSenderAddress, s.ChainClient)
	if err != nil {
		return errors.Errorf("failed to bind contract: %s", err)
	}

	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return errors.Errorf("failed to create transactor: %s", err)
	}

	tx, err := sender.SetExtensionId(opts)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason == "" {
			parsed, _ := nightjarauction.NightjarAuctionMetaData.GetAbi()
			if parsed != nil {
				callData, packErr := parsed.Pack("setExtensionId")
				if packErr == nil {
					from := crypto.PubkeyToAddress(s.Prv.PublicKey)
					reason = fccutils.SimulateAndDecodeRevert(
						s.ChainClient, from, instructionSenderAddress, nil, callData,
					)
				}
			}
		}
		if reason != "" {
			return errors.Errorf("failed to call setExtensionId: %s (revert reason: %s)", err, reason)
		}
		return errors.Errorf("failed to call setExtensionId: %s", err)
	}

	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return errors.Errorf("failed waiting for transaction: %s", err)
	}

	if receipt.Status != types.ReceiptStatusSuccessful {
		parsed, _ := nightjarauction.NightjarAuctionMetaData.GetAbi()
		if parsed != nil {
			callData, packErr := parsed.Pack("setExtensionId")
			if packErr == nil {
				from := crypto.PubkeyToAddress(s.Prv.PublicKey)
				reason := fccutils.SimulateAndDecodeRevert(
					s.ChainClient, from, instructionSenderAddress, nil, callData,
				)
				if reason != "" {
					return errors.Errorf("setExtensionId transaction failed (revert reason: %s)", reason)
				}
			}
		}
		return errors.New("setExtensionId transaction failed")
	}

	return nil
}

// SubmitOrder sends a sealed order into the current batch. The ciphertext is
// opaque to the chain; only the enclave can open it.
func SubmitOrder(s *support.Support, venue common.Address, ciphertext []byte) (common.Hash, common.Hash, error) {
	return sendInstruction(s, venue, "submitOrder", func(sender *nightjarauction.NightjarAuction, opts *bind.TransactOpts) (*types.Transaction, error) {
		return sender.SubmitOrder(opts, ciphertext)
	}, ciphertext)
}

// RunBatch asks the enclave to clear the current batch.
func RunBatch(s *support.Support, venue common.Address) (common.Hash, common.Hash, error) {
	return sendInstruction(s, venue, "runBatch", func(sender *nightjarauction.NightjarAuction, opts *bind.TransactOpts) (*types.Transaction, error) {
		return sender.RunBatch(opts)
	})
}

// sendInstruction wraps the common path: bind, attach the instruction fee,
// send, wait, and pull the instruction id out of the TeeInstructionsSent event.
func sendInstruction(
	s *support.Support,
	venue common.Address,
	method string,
	call func(*nightjarauction.NightjarAuction, *bind.TransactOpts) (*types.Transaction, error),
	packArgs ...interface{},
) (common.Hash, common.Hash, error) {
	sender, err := nightjarauction.NewNightjarAuction(venue, s.ChainClient)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to bind contract: %s", err)
	}

	opts, err := bind.NewKeyedTransactorWithChainID(s.Prv, s.ChainID)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to create transactor: %s", err)
	}
	opts.Value = big.NewInt(1000000) // Instruction fee in wei — must match the registry's required fee
	// Estimation runs against a block where the FTSO feed storage is already
	// warm; execution can touch cold slots and exceed the estimate, which shows
	// up as a revert at ~99% of the limit. Set a generous ceiling instead —
	// unused gas is refunded.
	opts.GasLimit = 1_500_000

	decodeRevert := func() string {
		parsed, _ := nightjarauction.NightjarAuctionMetaData.GetAbi()
		if parsed == nil {
			return ""
		}
		callData, packErr := parsed.Pack(method, packArgs...)
		if packErr != nil {
			return ""
		}
		from := crypto.PubkeyToAddress(s.Prv.PublicKey)
		return fccutils.SimulateAndDecodeRevert(s.ChainClient, from, venue, big.NewInt(1000000), callData)
	}

	tx, err := call(sender, opts)
	if err != nil {
		reason := fccutils.DecodeRevertReason(err)
		if reason == "" {
			reason = decodeRevert()
		}
		if reason != "" {
			return common.Hash{}, common.Hash{}, errors.Errorf("failed to send %s: %s (revert reason: %s)", method, err, reason)
		}
		return common.Hash{}, common.Hash{}, errors.Errorf("failed to send %s: %s", method, err)
	}

	receipt, err := bind.WaitMined(context.Background(), s.ChainClient, tx)
	if err != nil {
		return common.Hash{}, common.Hash{}, errors.Errorf("failed waiting for transaction: %s", err)
	}

	if receipt.Status != 1 {
		if reason := decodeRevert(); reason != "" {
			return common.Hash{}, common.Hash{}, errors.Errorf("%s failed (revert reason: %s)", method, reason)
		}
		return common.Hash{}, common.Hash{}, errors.Errorf("%s failed with status: %d", method, receipt.Status)
	}

	if len(receipt.Logs) == 0 {
		return common.Hash{}, common.Hash{}, errors.New("no logs found in receipt")
	}

	// The venue emits its own events too; find the registry's instruction event.
	for _, l := range receipt.Logs {
		if sent, parseErr := s.TeeVerification.ParseTeeInstructionsSent(*l); parseErr == nil {
			return sent.InstructionId, receipt.TxHash, nil
		}
	}
	return common.Hash{}, common.Hash{}, errors.New("TeeInstructionsSent event not found in receipt")
}
