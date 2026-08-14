// Package config contains configuration values and defaults used by the extension.
package config

import (
	"os"
	"strconv"
	"time"
)

const (
	Version = "0.1.0"

	// These strings must match the bytes32 constants in NightjarAuction.sol
	// exactly. A mismatch surfaces as "unsupported op type" or "unsupported op
	// command" at runtime, never at compile time.
	OPTypeAuction         = "AUCTION"
	OPCommandSubmitOrder  = "SUBMIT_ORDER"
	OPCommandRunBatch     = "RUN_BATCH"

	TimeoutShutdown = 5 * time.Second
)

// Defaults.
var (
	ExtensionPort = 8080
	SignPort      = 9090
)

// Environment variables override defaults.
func init() {
	ep := os.Getenv("EXTENSION_PORT")
	sp := os.Getenv("SIGN_PORT")

	if ep != "" {
		if v, err := strconv.Atoi(ep); err == nil {
			ExtensionPort = v
		}
	}
	if sp != "" {
		if v, err := strconv.Atoi(sp); err == nil {
			SignPort = v
		}
	}
}
