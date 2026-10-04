# GameRecords: what to deploy

Short version: deploy ONE contract, `GameRecords`, on **Base Sepolia (testnet, chain id 84532)** first. It takes two constructor arguments. It holds no tokens, no ETH, and pays nothing. It is only a public record book for the CAPHET Arena coin stacking game.

Do not deploy to Base mainnet until Cap says so. Do not send any funds or tokens to the contract. A plain ETH send to it reverts on purpose.

## Constructor arguments

| Position | Name | Type | What to pass |
| --- | --- | --- | --- |
| 1 | `initialOwner` | address | Cap's admin wallet (ideally a Safe multisig). This address can set operators, pause, and hand over ownership. It can NOT write records. **Cap provides this.** |
| 2 | `initialOperator` | address | The game server's signer, a dedicated hot wallet used only for this. It is the only kind of address that can write records. **Cap provides this** (a fresh wallet; its private key goes only into the server's `OPERATOR_PRIVATE_KEY` setting). |

Neither may be the zero address. The deployer wallet only pays gas and gets no special rights, so it can be any funded testnet wallet (including Bankr's).

## How to deploy

### Option A: Foundry (in this folder)

```
cd contracts
export OWNER_ADDRESS=0x...        # initialOwner
export OPERATOR_ADDRESS=0x...     # initialOperator
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# dry run first, nothing is sent:
forge script script/Deploy.s.sol --rpc-url base_sepolia
# real testnet deployment (deployer key via --private-key or --account):
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_KEY
```

Add `--verify` and set `BASESCAN_API_KEY` to verify the source on BaseScan.

### Option B: no Foundry

`artifacts/GameRecords.json` holds the ABI and creation bytecode (solc 0.8.24, optimizer 200 runs, EVM cancun, no metadata hash). Deploy the bytecode with the two constructor arguments ABI-encoded and appended, using any tool. Example constructor encoding with cast:

```
cast abi-encode "constructor(address,address)" <OWNER> <OPERATOR>
```

## What to send back to Cap

1. Contract address on Base Sepolia.
2. Deployment transaction hash and block number.
3. The two addresses actually used (owner and operator).
4. Whether the source was verified on BaseScan (link).

## Check after deploying

Read these from the contract. They should match:

- `owner()` equals the owner address.
- `isOperator(<operator>)` is `true`. `isOperator(<owner>)` is `false`.
- `paused()` is `false`.
- `totalRounds()` is `0`.

## What the contract does (plain words)

- Stores, per wallet and per mode (0 single, 1 twin, 2 triple): best score and number of rounds played.
- Stores each finished round once: round id hash, wallet, mode, outcome (0 fell, 1 cashed out, 2 stacks connected), score, volume bucket (0 to 10), seed commitment, hash of the move list, time. A round id cannot be written twice.
- Only an operator address can call `recordRound`. Owner can add or remove operators (`setOperator`), pause (`pause`, `unpause`), and move ownership in two steps (`transferOwnership` then `acceptOwnership` by the new owner).
- Emits `RoundRecorded`, `NewBestScore`, `OperatorSet`, `Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`.
- No payouts, no token transfers, no upgrade proxy, no selfdestruct. Reads are open to everyone.

## After deployment (Cap or the server operator)

Put these in the server environment: `CHAIN_RECORDS=on`, `CHAIN_ID=84532`, `CHAIN_RPC_URL`, `GAME_RECORDS_ADDRESS=<address>`, `OPERATOR_PRIVATE_KEY=<operator key>`, and `AUTH_MODE=signature`. The operator wallet needs a small amount of Base Sepolia ETH for gas (a few cents' worth covers thousands of rounds on Base). To rotate the operator key later, the owner calls `setOperator(new, true)` and then `setOperator(old, false)`.

## Tests

`cd contracts && forge test` runs 16 tests (roles, pause, duplicate rounds, bad inputs, best score logic, two-step ownership, ETH rejection, fuzz tests). The server side is checked against a real local chain with `npx tsx scripts/chain-local-check.ts` from the repo root.
