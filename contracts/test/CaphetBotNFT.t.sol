// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CaphetBotNFT} from "../src/CaphetBotNFT.sol";
import {CaphetBotDailyClaim} from "../src/CaphetBotDailyClaim.sol";
import {MockGear} from "./MockGear.sol";

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prevrandao(bytes32) external;
}

contract CaphetBotNFTTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address owner = address(0xA11CE);
    address treasury = address(0x7CEA5);
    address vault = address(0xBEEF);
    address alice = address(0xA1);
    address bob = address(0xB2);
    address stranger = address(0xBAD);

    bytes32 constant SEED = keccak256("caphet-mint-seed-v1");
    bytes32 commitHash;

    MockGear gear;
    CaphetBotNFT nft;
    CaphetBotDailyClaim claim;

    function setUp() public {
        gear = new MockGear(18);
        commitHash = keccak256(abi.encodePacked(SEED));
        nft = new CaphetBotNFT(owner, address(gear), treasury, vault, "https://caphet.example/meta/");
        claim = new CaphetBotDailyClaim(address(nft), owner);
        // fund minters
        gear.mint(alice, 1_000_000 ether);
        gear.mint(bob, 1_000_000 ether);
        gear.mint(stranger, 1_000_000 ether);
    }

    function _openMint() internal {
        vm.startPrank(owner);
        nft.commitMintSeed(commitHash);
        nft.revealMintSeed(SEED);
        nft.openMint();
        vm.stopPrank();
    }

    function _mintAs(address who) internal returns (uint256 id) {
        vm.startPrank(who);
        gear.approve(address(nft), nft.mintPrice());
        id = nft.mint();
        vm.stopPrank();
    }

    function test_constructor_setsRolesAndPrice() public view {
        require(nft.owner() == owner, "owner");
        require(address(nft.gear()) == address(gear), "gear");
        require(nft.treasury() == treasury && nft.gearVault() == vault, "split");
        require(nft.mintPrice() == 100 ether, "price");
        require(nft.MAX_SUPPLY() == 1000, "supply");
        require(!nft.mintOpened() && !nft.seedRevealed(), "closed");
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.ZeroAddress.selector));
        new CaphetBotNFT(address(0), address(gear), treasury, vault, "");
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.ZeroAddress.selector));
        new CaphetBotNFT(owner, address(0), treasury, vault, "");
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.ZeroAddress.selector));
        new CaphetBotNFT(owner, address(gear), address(0), vault, "");
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.ZeroAddress.selector));
        new CaphetBotNFT(owner, address(gear), treasury, address(0), "");
    }

    function test_commitRevealOpen_happyPath() public {
        vm.startPrank(owner);
        nft.commitMintSeed(commitHash);
        require(nft.seedCommit() == commitHash, "commit");
        nft.revealMintSeed(SEED);
        require(nft.seedRevealed() && nft.seed() == SEED, "seed");
        nft.openMint();
        require(nft.mintOpened(), "open");
        vm.stopPrank();
    }

    function test_reveal_rejectsBadSeed() public {
        vm.startPrank(owner);
        nft.commitMintSeed(commitHash);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.BadSeedReveal.selector));
        nft.revealMintSeed(keccak256("wrong"));
        vm.stopPrank();
    }

    function test_mint_beforeOpen_reverts() public {
        vm.prank(alice);
        gear.approve(address(nft), nft.mintPrice());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.SeedNotRevealed.selector));
        nft.mint();
    }

    function test_mint_pullsGearAndSplits90_10() public {
        _openMint();
        uint256 price = nft.mintPrice();
        uint256 t0 = gear.balanceOf(treasury);
        uint256 v0 = gear.balanceOf(vault);
        uint256 a0 = gear.balanceOf(alice);
        uint256 id = _mintAs(alice);
        require(id == 1, "id");
        require(nft.ownerOf(1) == alice, "ownerOf");
        require(nft.hasMinted(alice), "flag");
        require(nft.totalSupply() == 1, "supply");
        require(gear.balanceOf(treasury) == t0 + (price * 9000) / 10000, "treasury");
        require(gear.balanceOf(vault) == v0 + (price - (price * 9000) / 10000), "vault");
        require(gear.balanceOf(alice) == a0 - price, "paid");
        require(
            keccak256(bytes(nft.tokenURI(1))) == keccak256(bytes("https://caphet.example/meta/1.json")),
            "uri"
        );
    }

    function test_mint_onePerWallet() public {
        _openMint();
        _mintAs(alice);
        vm.startPrank(alice);
        gear.approve(address(nft), nft.mintPrice());
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.AlreadyMinted.selector));
        nft.mint();
        vm.stopPrank();
    }

    function test_mint_assignsRarityAndHardCapPayout() public {
        _openMint();
        uint256 id = _mintAs(alice);
        uint8 r = nft.rarityOf(id);
        require(r <= 3, "rarity range");
        uint256 payout = nft.dailyPayoutOf(id);
        if (r == 0) require(payout == 10, "c");
        if (r == 1) require(payout == 20, "u");
        if (r == 2) require(payout == 50, "r");
        if (r == 3) require(payout == 100, "m");
        // hard cap: never above mythic daily
        require(payout <= nft.PAYOUT_MYTHIC(), "cap");
    }

    function test_rarityFromRoll_weights() public view {
        uint256 c; uint256 u; uint256 r; uint256 m;
        for (uint256 i = 0; i < 100; i++) {
            uint8 x = nft.rarityFromRoll(i);
            if (x == 0) c++;
            else if (x == 1) u++;
            else if (x == 2) r++;
            else m++;
        }
        require(c == 50 && u == 30 && r == 15 && m == 5, "weights");
    }

    function test_payoutForRarity_table() public view {
        require(nft.payoutForRarity(0) == 10, "10");
        require(nft.payoutForRarity(1) == 20, "20");
        require(nft.payoutForRarity(2) == 50, "50");
        require(nft.payoutForRarity(3) == 100, "100");
    }

    function test_pause_blocksMintAndTransfer() public {
        _openMint();
        uint256 id = _mintAs(alice);
        vm.prank(owner);
        nft.pause();
        vm.startPrank(bob);
        gear.approve(address(nft), nft.mintPrice());
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.PausedError.selector));
        nft.mint();
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.PausedError.selector));
        nft.transferFrom(alice, bob, id);
        vm.prank(owner);
        nft.unpause();
        vm.prank(alice);
        nft.transferFrom(alice, bob, id);
        require(nft.ownerOf(id) == bob, "xfer");
    }

    function test_soldOut_at1000() public {
        _openMint();
        // mint 999 with unique wallets via create2-like addresses
        for (uint256 i = 1; i <= 999; i++) {
            address w = address(uint160(1000 + i));
            gear.mint(w, 100 ether);
            vm.startPrank(w);
            gear.approve(address(nft), nft.mintPrice());
            nft.mint();
            vm.stopPrank();
        }
        require(nft.totalSupply() == 999, "999");
        address last = address(uint160(2000));
        gear.mint(last, 100 ether);
        vm.startPrank(last);
        gear.approve(address(nft), nft.mintPrice());
        nft.mint();
        vm.stopPrank();
        require(nft.totalSupply() == 1000, "1000");
        address extra = address(uint160(3000));
        gear.mint(extra, 100 ether);
        vm.startPrank(extra);
        gear.approve(address(nft), nft.mintPrice());
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.SoldOut.selector));
        nft.mint();
        vm.stopPrank();
    }

    function test_onlyOwner_admin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.NotOwner.selector));
        nft.commitMintSeed(commitHash);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.NotOwner.selector));
        nft.setTreasury(stranger);
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        nft.transferOwnership(bob);
        require(nft.pendingOwner() == bob, "pending");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CaphetBotNFT.NotPendingOwner.selector));
        nft.acceptOwnership();
        vm.prank(bob);
        nft.acceptOwnership();
        require(nft.owner() == bob, "new owner");
    }

    function test_rejectsEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(nft).call{value: 1 ether}("");
        require(!ok, "no eth");
    }

    function test_claimStub_alwaysReverts() public {
        _openMint();
        uint256 id = _mintAs(alice);
        require(claim.quote(id) == nft.dailyPayoutOf(id), "quote");
        vm.expectRevert(abi.encodeWithSelector(CaphetBotDailyClaim.NotLive.selector));
        claim.claim(id, 1, hex"");
    }

    function test_vaultLimits_documented() public view {
        require(nft.VAULT_DAY_LIMIT_CAPH() == 500_000, "day");
        require(nft.VAULT_PER_PAYOUT_LIMIT_CAPH() == 10_000, "per");
        require(nft.PAYOUT_MYTHIC() <= nft.VAULT_PER_PAYOUT_LIMIT_CAPH(), "mythic under per-payout");
    }

    function test_approveAndTransfer() public {
        _openMint();
        uint256 id = _mintAs(alice);
        vm.prank(alice);
        nft.approve(bob, id);
        vm.prank(bob);
        nft.transferFrom(alice, stranger, id);
        require(nft.ownerOf(id) == stranger, "to stranger");
        require(nft.getApproved(id) == address(0), "cleared");
    }
}
