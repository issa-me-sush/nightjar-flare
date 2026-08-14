package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// teeClient talks to the TEE node's sign server, which listens on loopback
// inside the enclave. Both the decryption key and the signing key live in the
// node and never enter this process's address space.
type teeClient struct {
	baseURL string
	http    *http.Client
}

func newTeeClient(signPort int) *teeClient {
	return &teeClient{
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", signPort),
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

type decryptRequest struct {
	EncryptedMessage []byte `json:"encryptedMessage"`
}

type decryptResponse struct {
	DecryptedMessage []byte `json:"decryptedMessage"`
}

type signRequest struct {
	Message []byte `json:"message"`
}

type signResponse struct {
	Message   []byte `json:"message"`
	Signature []byte `json:"signature"`
}

// Decrypt opens an ECIES ciphertext with the TEE's private key. This is the
// only way an order's terms become readable, and it happens inside the enclave.
func (c *teeClient) Decrypt(ciphertext []byte) ([]byte, error) {
	var out decryptResponse
	if err := c.post("/decrypt", decryptRequest{EncryptedMessage: ciphertext}, &out); err != nil {
		return nil, err
	}
	return out.DecryptedMessage, nil
}

// Sign produces a 65-byte recoverable signature over keccak256(message) using
// the TEE key. The on-chain venue recovers this address and compares it to the
// TEE it has registered.
func (c *teeClient) Sign(message []byte) ([]byte, error) {
	var out signResponse
	if err := c.post("/sign", signRequest{Message: message}, &out); err != nil {
		return nil, err
	}
	if len(out.Signature) != 65 {
		return nil, fmt.Errorf("expected 65-byte signature, got %d", len(out.Signature))
	}
	return out.Signature, nil
}

func (c *teeClient) post(path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("encoding %s request: %w", path, err)
	}

	resp, err := c.http.Post(c.baseURL+path, "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("calling %s: %w", path, err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s returned %d: %s", path, resp.StatusCode, bytes.TrimSpace(msg))
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decoding %s response: %w", path, err)
	}
	return nil
}
