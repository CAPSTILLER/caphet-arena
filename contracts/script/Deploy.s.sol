// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GameRecords} from "../src/GameRecords.sol";

interface VmDeploy {
    function envAddress(string calldata) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Deploys GameRecords. Reads two addresses from the environment:
///   OWNER_ADDRESS     admin (multisig or Cap's safe), set operators, pause, hand over ownership
///   OPERATOR_ADDRESS  the game server's signer
/// Dry run (no broadcast):
///   forge script script/Deploy.s.sol --rpc-url base_sepolia
/// Real deployment to Base Sepolia (testnet), from the wallet given with --private-key / --account:
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
/// The deployer pays gas only and gets no special rights. Rights go to OWNER_ADDRESS and OPERATOR_ADDRESS.
contract Deploy {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (GameRecords g) {
        address owner = vm.envAddress("OWNER_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        vm.startBroadcast();
        g = new GameRecords(owner, operator);
        vm.stopBroadcast();
    }
}
