import { defineChain } from "viem";

export const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] } },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
  testnet: true,
});

export const VENUE = "0xA290b54398a0D8C0EbD719Ec33846b69Cf913094" as const;

/** The transparent control venue, for the side-by-side comparison. */
export const CONTROL_VENUE = "0xD2Ce3f06E446Cf967eEC4F3D6fdBB0063be44456" as const;

/**
 * The XRP Ledger door. Pay XRP to the desk's account naming a Flare address in
 * the payment reference, and this contract credits it once Flare's Data
 * Connector has attested the payment.
 */
export const XRPL_GATEWAY = "0xbc62e861C31Ce6581524b4A6d5518eb3a48eF708" as const;

/** The desk's XRPL account. Payments to anything else are not creditable. */
export const XRPL_DESK_ACCOUNT = "rLVHnCwBLXxW4FhuQdSvihxT4s8v5Y6yVf" as const;

/** Explorer for the XRPL testnet side of the rail. */
export const XRPL_EXPLORER = "https://testnet.xrpl.org" as const;

/** FCC extension serving this venue. */
export const EXTENSION_ID = 66250;

/**
 * The enclaves the venue will accept a settlement from, and how many of them
 * have to agree. One is registered on Coston2 today; the contract path for
 * more is deployed, tested, and live — see the quorum section on /proof.
 */
export const QUORUM = { registered: 1, threshold: 1 } as const;

/** On-chain evidence of the full loop, for the proof page. */
export const PROOF = {
  sealedOrders: [
    "0xa8d612dfddb5dcf50bd4f277c6278672cb545116b602154b4bdbbe1bfce857fd",
    "0x1aba070a336ea8e0cf33ddb197e73cab07a382fe94962256c68816d025c5963a",
  ],
  settlement: "0x083d86d734cb021fc58b6225d4fe5f4964f65ed0c1c20990f8eb22dd5cfb2c6d",
  controlOrderId: 2,
  controlPosted: "0xc63d2cd004115c2f5edbf11393845db28917c82594f2a5521fc6b618b372262b",
  controlTaken: "0xb87f6b7c9918cb4fcf1e8a19773af0ad748e6faefce2ba6ea1b587e83958cb5c",
  settledBatch: 1,
} as const;

/**
 * A batch with real depth: a market maker's two-sided ladder plus one taker.
 * Five orders in, one filled pair out — and three orders whose terms the chain
 * never learned, which is the property a transparent book cannot offer.
 */
export const DEPTH_DEMO = {
  batch: 2,
  sealedOrders: [
    "0xe40ca5d2154e926e782f41075951396e75c94626a73688d7b0d4b126e608eabe",
    "0xa73b52f5b48989e26e63f6cfd1c6571c63cf2906d8ac081329ee172131da8b62",
    "0x06688bf1b043930177dd5a6e123e05455a0e69dfe51b3563b5272fcd32c94633",
    "0xc5b5d89f20161b5cb94b91fc5b707442a27e28598f4b5841862352884ab655e2",
    "0xa9ff65f909b5291579f5d1ec8ac6afb7591c8e8443c6fdecfe6fb9d142e41824",
  ],
  settlement: "0xa37aee2f156bc18bf5cd2699c15b25e7ff12d277b8d6730f6232f8364aab35f2",
} as const;

/**
 * FXRP on Flare mainnet, and the pools that would have to absorb a seller.
 * Read live by /depth — these are the addresses, not the numbers.
 */
export const MAINNET = {
  rpc: "https://flare-api.flare.network/ext/C/rpc",
  explorer: "https://flare-explorer.flare.network",
  fxrp: "0x74A296Ff45Cd57bA6e6Cc8B4E9F0B0d6B0F0FBBF",
} as const;

/** The real FAssets FXRP on Coston2 — not a mock. */
export const BASE_TOKEN = "0x0b6A3645c240605887a5532109323A3E12273dc7" as const;
export const BASE_SYMBOL = "FXRP";

/** Coston2 has no canonical USD₮0, so the quote side is a mintable stand-in. */
export const QUOTE_TOKEN = "0x4AAFF8FCe43dCfdCF2AA2Bbf07B98707A3547036" as const;
export const QUOTE_SYMBOL = "nUSD";

/** Both assets use 6 decimals. */
export const DECIMALS = 6;

/** Prices are quote-per-base, scaled by 1e18, matching PRICE_SCALE on-chain. */
export const PRICE_SCALE = 10n ** 18n;

/** Fee forwarded with each instruction, in wei. */
export const INSTRUCTION_FEE = 1_000_000n;
