// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// Minimal local declarations of the Flare Data Connector types this repo uses.
///
/// `flare-smart-contracts-v2` is not published as a package (see the note in
/// foundry.toml), so the FDC interfaces are declared here the same way the TEE
/// registry interfaces are — narrowed to what is actually called, and matching
/// Flare's published ABI exactly.
///
/// The struct layout is load-bearing: `verifyPayment` re-hashes this data and
/// checks it against the Merkle root the Data Connector published for the
/// voting round, so a field in the wrong order does not decode wrong — it fails
/// verification outright, which is the correct behaviour.

interface IPayment {
    struct RequestBody {
        bytes32 transactionId;
        uint256 inUtxo;
        uint256 utxo;
    }

    struct ResponseBody {
        uint64 blockNumber;
        uint64 blockTimestamp;
        bytes32 sourceAddressHash;
        bytes32 sourceAddressesRoot;
        bytes32 receivingAddressHash;
        bytes32 intendedReceivingAddressHash;
        int256 spentAmount;
        int256 intendedSpentAmount;
        int256 receivedAmount;
        int256 intendedReceivedAmount;
        bytes32 standardPaymentReference;
        bool oneToOne;
        uint8 status;
    }

    struct Response {
        bytes32 attestationType;
        bytes32 sourceId;
        uint64 votingRound;
        uint64 lowestUsedTimestamp;
        RequestBody requestBody;
        ResponseBody responseBody;
    }

    struct Proof {
        bytes32[] merkleProof;
        Response data;
    }
}

interface IFdcVerification {
    /// @notice True when `_proof` is in the Merkle tree the Data Connector
    ///         published for its voting round. Reverts nothing; a bad proof is
    ///         simply false.
    function verifyPayment(IPayment.Proof calldata _proof) external view returns (bool);
}
