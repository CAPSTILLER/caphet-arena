// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaphetBotNFT} from "../src/CaphetBotNFT.sol";

interface VmDeploy {
    function envAddress(string calldata) external returns (address);
    function envString(string calldata) external returns (string memory);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Deploys CaphetBotNFT on Base Sepolia (or Base). Does NOT open minting.
/// Env:
///   OWNER_ADDRESS      Cap admin (Safe)
///   GEAR_TOKEN         GEAR ERC-20 Cap provides
///   TREASURY_ADDRESS   90% of mint GEAR
///   GEAR_VAULT_ADDRESS 10% of mint GEAR
///   BASE_URI           metadata prefix, e.g. https://.../meta/
/// After deploy Cap must: commitMintSeed, revealMintSeed, openMint (in that order).
/// Dry run:  forge script script/DeployCaphetBotNFT.s.sol --rpc-url base_sepolia
/// Broadcast: forge script script/DeployCaphetBotNFT.s.sol --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_KEY
contract DeployCaphetBotNFT {
    VmDeploy constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (CaphetBotNFT n) {
        address owner = vm.envAddress("OWNER_ADDRESS");
        address gear = vm.envAddress("GEAR_TOKEN");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address vault = vm.envAddress("GEAR_VAULT_ADDRESS");
        string memory baseURI = vm.envString("BASE_URI");
        vm.startBroadcast();
        n = new CaphetBotNFT(owner, gear, treasury, vault, baseURI);
        vm.stopBroadcast();
    }
}
