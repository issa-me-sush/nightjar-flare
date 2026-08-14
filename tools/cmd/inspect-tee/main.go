// inspect-tee prints the on-chain record for a TEE machine, including the URL
// Flare's data providers will try to reach.
package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/flare-foundation/go-flare-common/pkg/contracts/tee/machinemanager"
)

func main() {
	reg := flag.String("reg", "0x5918Cd58e5caf755b8584649Aa24077822F87613", "TeeMachineRegistry (diamond)")
	rpc := flag.String("rpc", "https://coston2-api.flare.network/ext/C/rpc", "rpc url")
	tee := flag.String("tee", "", "tee machine address")
	flag.Parse()

	cc, err := ethclient.Dial(*rpc)
	if err != nil {
		panic(err)
	}
	mm, err := machinemanager.NewMachineManager(common.HexToAddress(*reg), cc)
	if err != nil {
		panic(err)
	}
	m, err := mm.GetTeeMachine(&bind.CallOpts{Context: context.Background()}, common.HexToAddress(*tee))
	if err != nil {
		fmt.Printf("getTeeMachine ERROR: %v\n", err)
		return
	}
	fmt.Printf("%+v\n", m)
}
